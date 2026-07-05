"""Reporting module — aggregates data from inventory and orders."""

from demo_package.inventory import Inventory
from demo_package.orders import Order
from demo_package.utils.formatting import format_currency


def inventory_report(inventory: Inventory) -> str:
    """Generate a summary report of current inventory state."""
    low = inventory.low_stock_items()
    total = inventory.total_value()
    lines = [
        "=== Inventory Report ===",
        f"Total inventory value: {format_currency(total)}",
        f"Low-stock items ({len(low)}): {', '.join(low) if low else 'none'}",
    ]
    return "\n".join(lines)


def order_summary(orders: list[Order]) -> dict:
    """Aggregate statistics across multiple orders."""
    total_revenue = sum(o.total() for o in orders)
    total_items = sum(sum(l.quantity for l in o.lines) for o in orders)
    total_points = sum(o.loyalty_points() for o in orders)
    return {
        "order_count": len(orders),
        "total_revenue": total_revenue,
        "total_items": total_items,
        "total_loyalty_points": total_points,
        "average_order_value": total_revenue / len(orders) if orders else 0,
    }
