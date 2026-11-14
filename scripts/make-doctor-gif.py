#!/usr/bin/env python3
"""Rebuild the adversarial doctor GIF from the current CLI."""
import subprocess
import sys
from pathlib import Path

if __name__ == "__main__":
    subprocess.run([sys.executable, str(Path(__file__).with_name("make-demo-gif.py")), "doctor"], check=True)
