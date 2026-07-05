"""Order processing — depends on models, inventory, and formatting."""

from demo_package.models import Product, PremiumProduct
from demo_package.inventory import Inventory
from demo_package.utils.formatting import format_currency, format_receipt_line
from demo_package.utils.validation import validate_quantity


class OrderLine:
    """A single line in an order."""

    def __init__(self, product: Product, quantity: int, discount_pct: float = 0):
        self.product = product
        self.quantity = validate_quantity(quantity)
        self.discount_pct = discount_pct

    def line_total(self) -> float:
        """Compute total for this line after discount."""
        unit = self.product.discounted_price(self.discount_pct)
        return unit * self.quantity

    def format(self) -> str:
        """Format for receipt display."""
        unit = self.product.discounted_price(self.discount_pct)
        return format_receipt_line(self.product.name, self.quantity, unit)


class Order:
    """An order that pulls from inventory."""

    def __init__(self, inventory: Inventory):
        self.inventory = inventory
        self.lines: list[OrderLine] = []

    def add_item(self, product_name: str, quantity: int, discount_pct: float = 0) -> bool:
        """Add an item.  Returns False if insufficient stock."""
        product = self.inventory.get_product(product_name)
        if product is None:
            return False
        if not self.inventory.remove_stock(product_name, quantity):
            return False
        self.lines.append(OrderLine(product, quantity, discount_pct))
        return True

    def total(self) -> float:
        """Order total after discounts."""
        return sum(line.line_total() for line in self.lines)

    def loyalty_points(self) -> int:
        """Total loyalty points earned (premium products only)."""
        pts = 0
        for line in self.lines:
            if isinstance(line.product, PremiumProduct):
                pts += line.product.loyalty_points * line.quantity
        return pts

    def receipt(self) -> str:
        """Generate a formatted receipt string."""
        parts = ["=" * 60, "  ORDER RECEIPT", "=" * 60]
        for line in self.lines:
            parts.append(line.format())
        parts.append("-" * 60)
        parts.append(f"  TOTAL: {format_currency(self.total()):>47s}")
        pts = self.loyalty_points()
        if pts:
            parts.append(f"  Loyalty points earned: {pts}")
        parts.append("=" * 60)
        return "\n".join(parts)
