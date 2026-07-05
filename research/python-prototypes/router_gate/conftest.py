"""Ensures the package root is importable during test collection (bare `pytest` works)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
