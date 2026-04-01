const ORDER_TERMS = ['kg', 'litre', 'pcs', 'order', 'need', 'send', 'deliver'];

export function detectSoftOrder(text) {
  const norm = (text || '').toLowerCase();
  if (!ORDER_TERMS.some(t => norm.includes(t))) return null;
  return {
    summary: text.slice(0, 140),
    confidence: 0.62,
    raw_text: text
  };
}
