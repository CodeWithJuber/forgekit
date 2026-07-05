"""Validation utility functions used across the package."""


def validate_positive(value: float) -> float:
    """Ensure a numeric value is positive."""
    if value < 0:
        raise ValueError(f"Value must be non-negative, got {value}")
    return float(value)


def validate_name(name: str) -> str:
    """Validate and normalize a name string."""
    if not name or not name.strip():
        raise ValueError("Name cannot be empty")
    return name.strip()


def validate_quantity(qty: int) -> int:
    """Ensure quantity is a positive integer."""
    if not isinstance(qty, int) or qty < 1:
        raise ValueError(f"Quantity must be a positive integer, got {qty}")
    return qty
