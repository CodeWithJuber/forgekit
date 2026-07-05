"""Formatting utilities for display output."""

from demo_package.utils.validation import validate_positive


def format_currency(amount: float) -> str:
    """Format a float as a USD currency string."""
    amount = validate_positive(amount)
    return f"${amount:,.2f}"


def format_receipt_line(name: str, qty: int, unit_price: float) -> str:
    """Format a single line item for a receipt."""
    total = qty * unit_price
    return f"  {name:<30s} {qty:>3d} x {format_currency(unit_price):>10s} = {format_currency(total):>10s}"
