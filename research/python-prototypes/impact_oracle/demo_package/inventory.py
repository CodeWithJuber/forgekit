"""Inventory management with stock tracking."""

from demo_package.models import Product
from demo_package.utils.validation import validate_quantity, validate_positive


class Inventory:
    """Manages stock levels for products."""

    def __init__(self):
        self._stock: dict[str, tuple[Product, int]] = {}

    def add_product(self, product: Product, quantity: int):
        """Add stock for a product."""
        quantity = validate_quantity(quantity)
        if product.name in self._stock:
            existing_product, existing_qty = self._stock[product.name]
            self._stock[product.name] = (existing_product, existing_qty + quantity)
        else:
            self._stock[product.name] = (product, quantity)

    def remove_stock(self, product_name: str, quantity: int) -> bool:
        """Remove stock.  Returns True if sufficient stock was available."""
        quantity = validate_quantity(quantity)
        if product_name not in self._stock:
            return False
        product, current = self._stock[product_name]
        if current < quantity:
            return False
        self._stock[product_name] = (product, current - quantity)
        return True

    def get_product(self, name: str) -> Product | None:
        """Look up a product by name."""
        entry = self._stock.get(name)
        return entry[0] if entry else None

    def stock_level(self, name: str) -> int:
        """Return current stock for a product."""
        entry = self._stock.get(name)
        return entry[1] if entry else 0

    def total_value(self) -> float:
        """Total value of all inventory at current prices."""
        return sum(p.price * qty for p, qty in self._stock.values())

    def low_stock_items(self, threshold: int = 5) -> list[str]:
        """Return names of products below the stock threshold."""
        return [name for name, (_, qty) in self._stock.items() if qty < threshold]
