-- =====================================================================
-- Migration: reset embeddings para gemini-embedding-2-preview
-- Motivo: o novo modelo tem espaço vetorial INCOMPATÍVEL com o 001.
-- Schema permanece vector(768) — só os dados são invalidados.
-- =====================================================================

truncate table public.product_embeddings;

comment on table public.product_embeddings is
  'Embeddings gerados com gemini-embedding-2-preview (multimodal, 768D via Matryoshka). Reset em 2026-04-20.';
