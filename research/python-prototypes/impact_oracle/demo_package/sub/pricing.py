"""Pricing analytics — deeper analysis of product pricing strategies."""

from demo_package.models import Product, PremiumProduct
from demo_package.utils.validation import validate_positive


def margin_analysis(product: Product, cost: float) -> dict:
    """Compute margin metrics for a product."""
    cost = validate_positive(cost)
    margin = product.price - cost
    margin_pct = (margin / product.price) * 100 if product.price > 0 else 0
    return {
        "product": product.name,
        "price": product.price,
        "cost": cost,
        "margin": margin,
        "margin_pct": round(margin_pct, 2),
        "is_premium": isinstance(product, PremiumProduct),
    }


def bulk_discount_curve(product: Product, quantities: list[int]) -> list[dict]:
    """Compute effective prices at various quantity tiers.

    Uses a simple rule: 5% additional discount per 10-unit tier.
    """
    results = []
    for qty in quantities:
        tier_discount = min(50.0, (qty // 10) * 5.0)
        effective = product.discounted_price(tier_discount)
        results.append({
            "quantity": qty,
            "tier_discount_pct": tier_discount,
            "unit_price": round(effective, 2),
            "total": round(effective * qty, 2),
        })
    return results
