/**
 * Image Matcher — identifica produtos do catálogo a partir de fotos enviadas pela cliente.
 *
 * Fluxo:
 *   1. describeImage(url)    → usa Gemini Vision para gerar descrição visual estruturada
 *   2. embedText(desc)       → gera embedding 768-dim com text-embedding-004
 *   3. findSimilarProducts() → busca top-K no Supabase via pgvector cosine
 *   4. confirmMatch()        → Gemini Vision compara foto da cliente com top candidatos
 *      e devolve o produto certo com nível de confiança
 */

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const logger = require('./logger');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const VISION_MODEL    = 'gemini-2.5-flash-lite';
const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIMS  = 768;

// Moda íntima / pijamas são catálogo legítimo — relaxamos filtros para evitar
// que o modelo bloqueie lingerie, sutiãs etc. como "conteúdo sexual explícito".
// Usamos BLOCK_ONLY_HIGH: só bloqueia nas violações mais graves.
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

const DESCRIBE_PROMPT = `Analise esta foto de moda íntima/pijama e descreva em português, em 4-7 linhas, destacando:
- Quantidade de modelos na foto: UMA pessoa adulta, UMA criança, OU DUAS (adulto + criança = conjunto mãe e filha / pai e filho)
- Tipo de peça (pijama curto, pijama longo, camisola, conjunto, regata, short-doll, etc.)
- Público exato: feminino adulto, feminino infantil, masculino adulto, masculino infantil, ou CONJUNTO MÃE E FILHA / PAI E FILHO
- PERSONAGEM, MARCA ou TEMA específico se houver — isto é CRÍTICO (ex: Hello Kitty, Stitch, Minecraft,
  Mickey, Minnie, Moana, Frozen, Elsa, Barbie, Cinderela, Homem-Aranha, Batman, Pokémon, Naruto,
  Lilo & Stitch, Snoopy, unicórnio, coração, bailarina, dinossauro, urso, flamingo, etc.)
- Texto, logo, número ou palavra visível estampado na peça
- Cores predominantes (máx. 3) — seja preciso (ex: rosa claro, azul bebê, azul marinho, creme, lilás)
- Estampa/padrão (liso, floral, listrado, poá, xadrez, tie-dye, geométrico, etc.)
- Detalhes marcantes (botões, renda, alça fina/larga, barra, laço, viés colorido, bordado, capuz, etc.)

ATENÇÃO:
- Se a foto mostrar adulto E criança juntos, deixe claro que é um conjunto mãe e filha / pai e filho.
- Se houver PERSONAGEM/MARCA identificável, cite o nome explicitamente — não use só "personagens".
Seja objetivo e concreto — essa descrição vai ser usada para busca semântica.`;

/**
 * Faz download da imagem e converte para base64 — Gemini Vision exige inline data.
 */
async function fetchImageAsBase64(imageUrl) {
  const res = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15_000 });
  const mimeType = res.headers['content-type'] || 'image/jpeg';
  return { data: Buffer.from(res.data).toString('base64'), mimeType };
}

async function describeImage(imageUrl, retries = 3) {
  const model = genAI.getGenerativeModel({ model: VISION_MODEL, safetySettings: SAFETY_SETTINGS });
  const { data, mimeType } = await fetchImageAsBase64(imageUrl);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await model.generateContent([
        { text: DESCRIBE_PROMPT },
        { inlineData: { data, mimeType } },
      ]);
      return result.response.text().trim();
    } catch (err) {
      const is503 = err.message?.includes('503') || err.message?.includes('overloaded');
      if (is503 && attempt < retries) {
        const delay = attempt * 4000;
        logger.warn({ attempt, delay }, '[ImageMatcher] 503 — aguardando antes de retry');
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

async function embedText(text) {
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  // gemini-embedding-001 retorna 3072 dims por padrão; truncamos para 768 via
  // outputDimensionality (Matryoshka) para caber no limite do HNSW do pgvector (2000).
  const result = await model.embedContent({
    content: { parts: [{ text }] },
    outputDimensionality: EMBEDDING_DIMS,
  });
  return result.embedding.values;
}

/**
 * Indexa um produto: descreve + embeda + persiste no Supabase.
 * Idempotente via upsert por product_id.
 */
async function indexProduct(product) {
  if (!product.imageUrl) {
    logger.warn({ productId: product.id }, '[ImageMatcher] Produto sem imagem — pulando');
    return null;
  }

  const description = await describeImage(product.imageUrl);
  const embedding   = await embedText(`${product.name}\n${description}`);

  const { error } = await supabase.from('product_embeddings').upsert({
    product_id:  product.id,
    name:        product.name,
    price:       parseFloat(product.price) || 0,
    image_url:   product.imageUrl,
    description,
    embedding,
    updated_at:  new Date().toISOString(),
  }, { onConflict: 'product_id' });

  if (error) {
    logger.error({ productId: product.id, err: error.message }, '[ImageMatcher] Falha ao persistir embedding');
    throw error;
  }

  return { productId: product.id, description };
}

/**
 * Busca os top-K produtos mais similares a uma foto recebida.
 */
async function findSimilarProducts(clientImageUrl, topK = 3) {
  const description = await describeImage(clientImageUrl);
  const embedding   = await embedText(description);

  const { data, error } = await supabase.rpc('match_products', {
    query_embedding: embedding,
    match_count:     topK,
  });

  if (error) {
    logger.error({ err: error.message }, '[ImageMatcher] RPC match_products falhou');
    throw error;
  }

  return { description, candidates: data || [] };
}

/**
 * Usa Gemini Vision para escolher o melhor match entre candidatos.
 * Devolve { productId, confidence (0-1), reason } ou null se nenhum bater.
 */
async function confirmMatch(clientImageUrl, candidates) {
  if (!candidates || candidates.length === 0) return null;

  const model = genAI.getGenerativeModel({ model: VISION_MODEL, safetySettings: SAFETY_SETTINGS });
  const clientImg = await fetchImageAsBase64(clientImageUrl);

  const candidateImgs = await Promise.all(candidates.map((c) => fetchImageAsBase64(c.image_url)));

  const parts = [
    { text: `Você vai comparar a FOTO DO CLIENTE com ${candidates.length} candidatos do catálogo da loja.

REGRAS DE COMPARAÇÃO (siga rigorosamente):
1. O produto correto deve ter o MESMO MODELO e MESMA ESTAMPA que a foto do cliente.
2. Preste atenção especial ao NÚMERO DE PESSOAS na foto:
   - Se a foto do cliente mostra adulto + criança juntos → é conjunto MÃE E FILHA (nunca escolha produto de adulto individual)
   - Se mostra só adulto → produto feminino/masculino adulto
   - Se mostra só criança → produto infantil
3. Cor deve ser compatível (rosa ≠ azul marinho, por exemplo).
4. Se nenhum candidato bater com certeza, retorne productId: null.
5. Nunca force um match — prefira null a um match errado.

Responda APENAS em JSON: {"productId": <id_ou_null>, "confidence": <0_a_1>, "reason": "..."}

FOTO DO CLIENTE:` },
    { inlineData: clientImg },
  ];

  candidates.forEach((c, i) => {
    parts.push({ text: `\nCandidato #${i + 1} — productId=${c.product_id} — ${c.name}:` });
    parts.push({ inlineData: candidateImgs[i] });
  });

  parts.push({ text: '\nResponda só o JSON, sem markdown.' });

  const result = await model.generateContent(parts);
  const raw = result.response.text().trim().replace(/^```json\s*|\s*```$/g, '');

  try {
    const parsed = JSON.parse(raw);
    return parsed.productId ? parsed : null;
  } catch (err) {
    logger.warn({ raw, err: err.message }, '[ImageMatcher] Falha ao parsear JSON do confirmMatch');
    return null;
  }
}

/**
 * Pipeline completo: foto → produto identificado (ou null).
 */
async function matchProductFromImage(clientImageUrl, { minConfidence = 0.7, topK = 5 } = {}) {
  const { candidates } = await findSimilarProducts(clientImageUrl, topK);
  if (candidates.length === 0) return null;

  const match = await confirmMatch(clientImageUrl, candidates);

  // Se o confirmMatch devolveu null/sem productId, tenta usar o top-1 da busca
  // vetorial como "palpite incerto" — ainda é útil pro admin revisar manualmente.
  if (!match || !match.productId) {
    const fallback = candidates[0];
    if (!fallback) return null;
    logger.info(
      { topCandidates: candidates.map((c) => c.product_id) },
      '[ImageMatcher] Nenhum match confirmado — retornando top candidato como incerto',
    );
    return {
      productId:  fallback.product_id,
      name:       fallback.name,
      price:      fallback.price,
      imageUrl:   fallback.image_url,
      confidence: 0,
      reason:     'confirmMatch não escolheu — top candidato por similaridade vetorial',
      uncertain:  true,
    };
  }

  const product = candidates.find((c) => c.product_id === match.productId);
  if (!product) return null;

  const uncertain = match.confidence < minConfidence;
  if (uncertain) {
    logger.info(
      { match, topCandidates: candidates.map((c) => c.product_id) },
      '[ImageMatcher] Confiança abaixo do limiar — marcando como incerto',
    );
  }

  return {
    productId:  product.product_id,
    name:       product.name,
    price:      product.price,
    imageUrl:   product.image_url,
    confidence: match.confidence,
    reason:     match.reason,
    uncertain,
  };
}

/**
 * Remove um produto da tabela de embeddings.
 * Usado pelo catalog-sync quando o produto é excluído ou despublicado no WooCommerce.
 */
async function removeProduct(productId) {
  const { error } = await supabase
    .from('product_embeddings')
    .delete()
    .eq('product_id', productId);
  if (error) {
    logger.error({ productId, err: error.message }, '[ImageMatcher] Falha ao remover embedding');
    throw error;
  }
  return { productId, removed: true };
}

/**
 * Lista todos os product_id já indexados no Supabase.
 * Usado pela reconciliação para detectar órfãos.
 */
async function listIndexedIds() {
  const all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('product_embeddings')
      .select('product_id')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data.map((r) => r.product_id));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

module.exports = {
  indexProduct,
  removeProduct,
  listIndexedIds,
  findSimilarProducts,
  confirmMatch,
  matchProductFromImage,
  describeImage,
  embedText,
};
