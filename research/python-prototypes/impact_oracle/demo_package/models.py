"""Core domain models."""

from demo_package.utils.validation import validate_positive, validate_name


class Product:
    """A product in the catalog."""

    def __init__(self, name: str, price: float, category: str = "general"):
        self.name = validate_name(name)
        self.price = validate_positive(price)
        self.category = category

    def discounted_price(self, discount_pct: float) -> float:
        """Return price after applying a percentage discount."""
        discount_pct = validate_positive(discount_pct)
        return self.price * (1 - discount_pct / 100)

    def __repr__(self):
        return f"Product({self.name!r}, ${self.price:.2f})"


class PremiumProduct(Product):
    """A premium product with loyalty points."""

    POINTS_PER_DOLLAR = 10

    def __init__(self, name: str, price: float, category: str = "premium"):
        super().__init__(name, price, category)
        self.loyalty_points = int(self.price * self.POINTS_PER_DOLLAR)

    def discounted_price(self, discount_pct: float) -> float:
        """Premium products cap discount at 30%."""
        capped = min(discount_pct, 30.0)
        return super().discounted_price(capped)
