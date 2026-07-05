"""Comprehensive tests for demo_package — used as ground truth for mutation testing."""

import pytest
from demo_package.models import Product, PremiumProduct
from demo_package.inventory import Inventory
from demo_package.orders import Order, OrderLine
from demo_package.reports import inventory_report, order_summary
from demo_package.sub.pricing import margin_analysis, bulk_discount_curve
from demo_package.utils.validation import validate_positive, validate_name, validate_quantity
from demo_package.utils.formatting import format_currency, format_receipt_line


# --- Validation tests ---

class TestValidation:
    def test_validate_positive_ok(self):
        assert validate_positive(5.0) == 5.0
        assert validate_positive(0) == 0.0

    def test_validate_positive_negative(self):
        with pytest.raises(ValueError):
            validate_positive(-1)

    def test_validate_name_ok(self):
        assert validate_name("  Widget  ") == "Widget"

    def test_validate_name_empty(self):
        with pytest.raises(ValueError):
            validate_name("")

    def test_validate_quantity_ok(self):
        assert validate_quantity(3) == 3

    def test_validate_quantity_bad(self):
        with pytest.raises(ValueError):
            validate_quantity(0)
        with pytest.raises(ValueError):
            validate_quantity(-1)


# --- Formatting tests ---

class TestFormatting:
    def test_format_currency(self):
        assert format_currency(1234.5) == "$1,234.50"
        assert format_currency(0) == "$0.00"

    def test_format_receipt_line(self):
        line = format_receipt_line("Widget", 3, 10.0)
        assert "Widget" in line
        assert "$10.00" in line
        assert "$30.00" in line


# --- Model tests ---

class TestProduct:
    def test_create_product(self):
        p = Product("Widget", 29.99)
        assert p.name == "Widget"
        assert p.price == 29.99
        assert p.category == "general"

    def test_discounted_price(self):
        p = Product("Widget", 100.0)
        assert p.discounted_price(10) == 90.0
        assert p.discounted_price(0) == 100.0

    def test_discounted_price_validates(self):
        p = Product("Widget", 100.0)
        with pytest.raises(ValueError):
            p.discounted_price(-5)

    def test_repr(self):
        p = Product("Widget", 29.99)
        assert "Widget" in repr(p)


class TestPremiumProduct:
    def test_inherits_product(self):
        pp = PremiumProduct("Deluxe Widget", 199.99)
        assert isinstance(pp, Product)
        assert pp.category == "premium"

    def test_loyalty_points(self):
        pp = PremiumProduct("Deluxe", 100.0)
        assert pp.loyalty_points == 1000  # 100 * 10

    def test_discount_cap(self):
        pp = PremiumProduct("Deluxe", 100.0)
        # 50% discount should be capped at 30%
        assert pp.discounted_price(50) == 70.0
        # 20% discount passes through
        assert pp.discounted_price(20) == 80.0


# --- Inventory tests ---

class TestInventory:
    def test_add_and_get(self):
        inv = Inventory()
        p = Product("Widget", 10.0)
        inv.add_product(p, 5)
        assert inv.get_product("Widget") is p
        assert inv.stock_level("Widget") == 5

    def test_add_existing_increases_stock(self):
        inv = Inventory()
        p = Product("Widget", 10.0)
        inv.add_product(p, 5)
        inv.add_product(p, 3)
        assert inv.stock_level("Widget") == 8

    def test_remove_stock(self):
        inv = Inventory()
        inv.add_product(Product("Widget", 10.0), 10)
        assert inv.remove_stock("Widget", 3) is True
        assert inv.stock_level("Widget") == 7

    def test_remove_stock_insufficient(self):
        inv = Inventory()
        inv.add_product(Product("Widget", 10.0), 2)
        assert inv.remove_stock("Widget", 5) is False
        assert inv.stock_level("Widget") == 2  # unchanged

    def test_remove_stock_nonexistent(self):
        inv = Inventory()
        assert inv.remove_stock("Ghost", 1) is False

    def test_total_value(self):
        inv = Inventory()
        inv.add_product(Product("A", 10.0), 5)
        inv.add_product(Product("B", 20.0), 3)
        assert inv.total_value() == 10 * 5 + 20 * 3

    def test_low_stock_items(self):
        inv = Inventory()
        inv.add_product(Product("Low", 10.0), 2)
        inv.add_product(Product("High", 10.0), 100)
        assert inv.low_stock_items() == ["Low"]


# --- Order tests ---

class TestOrderLine:
    def test_line_total_no_discount(self):
        p = Product("Widget", 50.0)
        line = OrderLine(p, 3)
        assert line.line_total() == 150.0

    def test_line_total_with_discount(self):
        p = Product("Widget", 100.0)
        line = OrderLine(p, 2, discount_pct=10)
        assert line.line_total() == 180.0


class TestOrder:
    def _make_inventory(self):
        inv = Inventory()
        inv.add_product(Product("Widget", 50.0), 100)
        inv.add_product(PremiumProduct("Deluxe", 200.0), 50)
        return inv

    def test_add_item_success(self):
        inv = self._make_inventory()
        order = Order(inv)
        assert order.add_item("Widget", 3) is True
        assert len(order.lines) == 1
        assert inv.stock_level("Widget") == 97

    def test_add_item_insufficient_stock(self):
        inv = self._make_inventory()
        order = Order(inv)
        assert order.add_item("Widget", 999) is False

    def test_add_item_nonexistent(self):
        inv = self._make_inventory()
        order = Order(inv)
        assert order.add_item("Nonexistent", 1) is False

    def test_total(self):
        inv = self._make_inventory()
        order = Order(inv)
        order.add_item("Widget", 2)
        order.add_item("Deluxe", 1)
        assert order.total() == 2 * 50 + 200

    def test_loyalty_points(self):
        inv = self._make_inventory()
        order = Order(inv)
        order.add_item("Widget", 1)     # no points
        order.add_item("Deluxe", 2)     # 200*10 * 2 = 4000
        assert order.loyalty_points() == 4000

    def test_receipt(self):
        inv = self._make_inventory()
        order = Order(inv)
        order.add_item("Widget", 1)
        r = order.receipt()
        assert "RECEIPT" in r
        assert "TOTAL" in r


# --- Reports tests ---

class TestReports:
    def test_inventory_report(self):
        inv = Inventory()
        inv.add_product(Product("Low", 10.0), 2)
        inv.add_product(Product("High", 50.0), 100)
        report = inventory_report(inv)
        assert "Low" in report
        assert "$" in report

    def test_order_summary(self):
        inv = Inventory()
        inv.add_product(Product("W", 10.0), 100)
        o1 = Order(inv)
        o1.add_item("W", 5)
        o2 = Order(inv)
        o2.add_item("W", 3)
        summary = order_summary([o1, o2])
        assert summary["order_count"] == 2
        assert summary["total_items"] == 8
        assert summary["total_revenue"] == 80.0


# --- Pricing analytics tests ---

class TestPricing:
    def test_margin_analysis(self):
        p = Product("W", 100.0)
        result = margin_analysis(p, 60.0)
        assert result["margin"] == 40.0
        assert result["margin_pct"] == 40.0
        assert result["is_premium"] is False

    def test_margin_analysis_premium(self):
        pp = PremiumProduct("D", 200.0)
        result = margin_analysis(pp, 80.0)
        assert result["is_premium"] is True

    def test_bulk_discount_curve(self):
        p = Product("W", 100.0)
        curve = bulk_discount_curve(p, [1, 10, 20, 100])
        assert len(curve) == 4
        assert curve[0]["tier_discount_pct"] == 0.0   # qty 1
        assert curve[1]["tier_discount_pct"] == 5.0    # qty 10
        assert curve[2]["tier_discount_pct"] == 10.0   # qty 20
        assert curve[3]["tier_discount_pct"] == 50.0   # qty 100, capped

    def test_margin_analysis_validates(self):
        p = Product("W", 100.0)
        with pytest.raises(ValueError):
            margin_analysis(p, -10)
