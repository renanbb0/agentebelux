const PDFDocument = require('pdfkit');
const axios = require('axios');

const logger = require('./logger');
const woocommerce = require('./woocommerce');

const PAGE_MARGIN = 42;
const PHOTO_SIZE = 60;
const ITEM_GAP = 14;
const TEXT_GAP = 12;

function formatDateTime(now) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Fortaleza',
  }).format(now);
}

function buildVariationsText(variations = []) {
  return variations
    .map((variation) => {
      const sizeLabel = variation.variant
        ? `${variation.variant} - ${variation.size}`
        : variation.size;
      return `${sizeLabel} x${variation.quantity}`;
    })
    .join(' | ');
}

function calculatePixTotal(total, pixDiscountPct) {
  const numericTotal = parseFloat(total || 0);
  const discountPct = parseFloat(pixDiscountPct || 0);
  return numericTotal * (1 - (discountPct / 100));
}

async function fetchImageBuffer(imageUrl, axiosClient) {
  if (!imageUrl) return null;

  try {
    const response = await axiosClient.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
    });
    return Buffer.isBuffer(response.data)
      ? response.data
      : Buffer.from(response.data);
  } catch (err) {
    logger.warn({ imageUrl, err: err.message }, '[PDF] Falha ao baixar imagem do produto');
    return null;
  }
}

function drawPlaceholder(doc, x, y) {
  doc
    .save()
    .rect(x, y, PHOTO_SIZE, PHOTO_SIZE)
    .fillAndStroke('#EFEFEF', '#D0D0D0');

  doc
    .lineWidth(1)
    .strokeColor('#B8B8B8')
    .moveTo(x + 8, y + PHOTO_SIZE - 10)
    .lineTo(x + 24, y + 28)
    .lineTo(x + 38, y + 42)
    .lineTo(x + 52, y + 18)
    .stroke();

  doc
    .circle(x + 42, y + 18, 5)
    .strokeColor('#B8B8B8')
    .stroke();

  doc
    .fillColor('#777777')
    .font('Helvetica-Bold')
    .fontSize(8)
    .text('SEM FOTO', x + 6, y + PHOTO_SIZE - 16, {
      width: PHOTO_SIZE - 12,
      align: 'center',
    })
    .restore();
}

function drawItemBlock(doc, group, imageBuffer, startY) {
  const textX = PAGE_MARGIN + PHOTO_SIZE + TEXT_GAP;
  const textWidth = doc.page.width - PAGE_MARGIN - textX;
  const variationsText = buildVariationsText(group.variations);
  const piecesLabel = `${group.totalPieces} ${group.totalPieces === 1 ? 'peca' : 'pecas'}`;
  const subtotalLabel = woocommerce.formatPrice(group.subtotal);

  doc.font('Helvetica-Bold').fontSize(11);
  const nameHeight = doc.heightOfString(group.productName, { width: textWidth });

  doc.font('Helvetica').fontSize(9);
  const variationsHeight = doc.heightOfString(`Tamanhos: ${variationsText}`, { width: textWidth });
  const metaHeight = doc.heightOfString(`Total: ${piecesLabel} | Subtotal: ${subtotalLabel}`, { width: textWidth });

  const textHeight = nameHeight + 6 + variationsHeight + 6 + metaHeight;
  const blockHeight = Math.max(PHOTO_SIZE, textHeight) + 10;

  doc
    .save()
    .roundedRect(PAGE_MARGIN, startY, doc.page.width - (PAGE_MARGIN * 2), blockHeight)
    .fillAndStroke('#FFFFFF', '#DDDDDD')
    .restore();

  if (imageBuffer) {
    try {
      doc.image(imageBuffer, PAGE_MARGIN + 8, startY + 8, {
        fit: [PHOTO_SIZE, PHOTO_SIZE],
        align: 'center',
        valign: 'center',
      });
    } catch (err) {
      logger.warn({ productId: group.productId, err: err.message }, '[PDF] Falha ao embutir imagem no PDF');
      drawPlaceholder(doc, PAGE_MARGIN + 8, startY + 8);
    }
  } else {
    drawPlaceholder(doc, PAGE_MARGIN + 8, startY + 8);
  }

  let cursorY = startY + 8;
  doc.fillColor('#1F1F1F').font('Helvetica-Bold').fontSize(11)
    .text(group.productName, textX, cursorY, { width: textWidth });
  cursorY += nameHeight + 6;

  doc.fillColor('#4B4B4B').font('Helvetica').fontSize(9)
    .text(`Tamanhos: ${variationsText}`, textX, cursorY, { width: textWidth });
  cursorY += variationsHeight + 6;

  doc.fillColor('#1F1F1F').font('Helvetica-Bold').fontSize(9)
    .text(`Total: ${piecesLabel} | Subtotal: ${subtotalLabel}`, textX, cursorY, { width: textWidth });

  return startY + blockHeight + ITEM_GAP;
}

async function generateOrderPdf(
  { customerName, phone, productGroups = [], total, pixDiscountPct },
  deps = {}
) {
  const axiosClient = deps.axiosClient || axios;
  const now = deps.now instanceof Date ? deps.now : new Date();
  const pixTotal = calculatePixTotal(total, pixDiscountPct);

  const imageBuffers = new Map();
  for (const group of productGroups) {
    imageBuffers.set(group.productId, await fetchImageBuffer(group.imageUrl, axiosClient));
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: PAGE_MARGIN,
      info: {
        Title: 'Resumo do Pedido',
        Author: 'Agente Belux',
      },
    });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      logger.info(
        {
          phone,
          groupCount: productGroups.length,
          bytes: buffer.length,
        },
        '[PDF] generated'
      );
      resolve(buffer);
    });
    doc.on('error', reject);

    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(18)
      .text('BELUX MODA INTIMA', PAGE_MARGIN, PAGE_MARGIN);
    doc.fillColor('#555555').font('Helvetica-Bold').fontSize(11)
      .text('RESUMO DO PEDIDO', PAGE_MARGIN, PAGE_MARGIN + 24);
    doc.fillColor('#666666').font('Helvetica').fontSize(9)
      .text(`Gerado em ${formatDateTime(now)}`, PAGE_MARGIN, PAGE_MARGIN + 42);

    doc
      .save()
      .moveTo(PAGE_MARGIN, PAGE_MARGIN + 62)
      .lineTo(doc.page.width - PAGE_MARGIN, PAGE_MARGIN + 62)
      .strokeColor('#D8D8D8')
      .stroke()
      .restore();

    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(10)
      .text('CLIENTE', PAGE_MARGIN, PAGE_MARGIN + 78);
    doc.fillColor('#333333').font('Helvetica').fontSize(10)
      .text(customerName || 'Nao informado', PAGE_MARGIN, PAGE_MARGIN + 94)
      .text(`WhatsApp: ${phone || 'Nao informado'}`, PAGE_MARGIN, PAGE_MARGIN + 110);

    let cursorY = PAGE_MARGIN + 146;

    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(10)
      .text('ITENS DO PEDIDO', PAGE_MARGIN, cursorY);
    cursorY += 20;

    for (const group of productGroups) {
      const buffer = imageBuffers.get(group.productId) || null;
      const estimatedHeight = 84;
      const limitY = doc.page.height - PAGE_MARGIN - 120;
      if (cursorY + estimatedHeight > limitY) {
        doc.addPage();
        cursorY = PAGE_MARGIN;
        doc.fillColor('#111111').font('Helvetica-Bold').fontSize(10)
          .text('ITENS DO PEDIDO', PAGE_MARGIN, cursorY);
        cursorY += 20;
      }

      cursorY = drawItemBlock(doc, group, buffer, cursorY);
    }

    const totalBoxHeight = 78;
    if (cursorY + totalBoxHeight > doc.page.height - PAGE_MARGIN - 40) {
      doc.addPage();
      cursorY = PAGE_MARGIN;
    }

    doc
      .save()
      .roundedRect(PAGE_MARGIN, cursorY, doc.page.width - (PAGE_MARGIN * 2), totalBoxHeight)
      .fillAndStroke('#F7F7F7', '#DCDCDC')
      .restore();

    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(11)
      .text(`Total geral: ${woocommerce.formatPrice(total)}`, PAGE_MARGIN + 14, cursorY + 14);
    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(11)
      .text(`PIX (${pixDiscountPct}%): ${woocommerce.formatPrice(pixTotal)}`, PAGE_MARGIN + 14, cursorY + 34);
    doc.fillColor('#666666').font('Helvetica').fontSize(9)
      .text(
        'Pedido gerado pelo Agente Belux - aguardando confirmacao da consultora.',
        PAGE_MARGIN + 14,
        cursorY + 54
      );

    doc.end();
  });
}

module.exports = {
  generateOrderPdf,
};
