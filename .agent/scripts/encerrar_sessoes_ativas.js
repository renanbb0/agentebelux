/**
 * Encerra e arquiva TODAS as sessões ativas imediatamente,
 * sem esperar o timeout de 30min do ciclo automático.
 *
 * Uso: node .agent/scripts/encerrar_sessoes_ativas.js [--phone=55...]
 *
 * IMPORTANTE: pare o servidor (`Stop-Process -Name node`) antes de rodar.
 * Caso contrário, o servidor vai continuar escrevendo a sessão em memória
 * e pode sobrescrever o snapshot que acabou de ser arquivado.
 */

require('dotenv').config();
const db = require('../../services/supabase');
const archiver = require('../../services/session-archiver');
const logger = require('../../services/logger');

const args = process.argv.slice(2);
const targetPhone = (args.find(a => a.startsWith('--phone='))?.split('=')[1]) || null;

async function main() {
  // timeoutMs=0 → retorna todas as sessões com last_activity < agora (ou seja, TODAS)
  const all = await db.getExpiredSessions(0);
  const target = targetPhone ? all.filter(r => r.phone === targetPhone) : all;

  if (target.length === 0) {
    console.log(targetPhone
      ? `Nenhuma sessão encontrada para ${targetPhone}`
      : 'Nenhuma sessão ativa encontrada');
    return;
  }

  console.log(`Arquivando ${target.length} sessão(ões)...`);
  let archived = 0;
  let skipped = 0;

  for (const row of target) {
    try {
      const result = await archiver.archiveSupabaseRow(row);
      if (result?.archived) {
        archived++;
        console.log(`  ✓ ${row.phone} → outcome=${result.outcome}`);
      } else {
        skipped++;
        console.log(`  - ${row.phone} → skipped (${result?.reason || 'unknown'})`);
      }
    } catch (err) {
      console.error(`  ✗ ${row.phone} → ERRO: ${err.message}`);
    }
  }

  // Só apaga o que foi arquivado OU era "no_outcome" (navegação sem carrinho)
  const phonesToDelete = target.map(r => r.phone);
  for (const phone of phonesToDelete) {
    try {
      await db.supabase.from('sessions').delete().eq('phone', phone);
    } catch (err) {
      console.error(`  ✗ delete ${phone}: ${err.message}`);
    }
  }

  console.log(`\nResumo: ${archived} arquivadas, ${skipped} ignoradas (sem outcome), ${phonesToDelete.length} apagadas da tabela sessions`);
  console.log(`\nArquivos consultáveis agora:`);
  console.log(`  - Supabase: tabela session_archives`);
  console.log(`  - Local:    training_data/events.jsonl (append-only)`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
  });
