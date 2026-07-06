export function normalizeSku(sku) {
	return sku.trim();
}

export function totalCents(items) {
	return items.reduce((sum, item) => sum + item.priceCents, 0);
}

export function lowStock(items, threshold = 3) {
	return items.filter((item) => item.quantity < threshold).map((item) => item.sku);
}
