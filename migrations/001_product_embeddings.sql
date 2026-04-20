-- =====================================================================
-- Migration: product_embeddings
-- Objetivo: suportar busca por similaridade visual (foto do cliente → produto)
-- Requisitos: extensão pgvector
-- =====================================================================

-- 1) Habilita pgvector
create extension if not exists vector;

-- 2) Tabela de embeddings dos produtos
create table if not exists public.product_embeddings (
  product_id   bigint primary key,
  name         text   not null,
  price        numeric(10,2) default 0,
  image_url    text,
  description  text,
  embedding    vector(768) not null,          -- text-embedding-004 = 768 dim
  updated_at   timestamptz not null default now()
);

-- 3) Índice ANN para busca por cosine (HNSW é o melhor custo/benefício)
create index if not exists product_embeddings_embedding_idx
  on public.product_embeddings
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- 4) RPC que o serviço chama: top-K produtos mais similares
create or replace function public.match_products (
  query_embedding vector(768),
  match_count     int default 3
)
returns table (
  product_id  bigint,
  name        text,
  price       numeric,
  image_url   text,
  description text,
  similarity  float
)
language sql stable
as $$
  select
    pe.product_id,
    pe.name,
    pe.price,
    pe.image_url,
    pe.description,
    1 - (pe.embedding <=> query_embedding) as similarity
  from public.product_embeddings pe
  order by pe.embedding <=> query_embedding
  limit match_count;
$$;
