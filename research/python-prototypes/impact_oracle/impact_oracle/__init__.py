"""Impact Oracle: A Codebase World-Model + Impact Prediction Engine.

Provides persistent structural analysis of Python codebases and
blast-radius prediction for proposed symbol changes.
"""

__version__ = "0.2.0"

from impact_oracle.world_model import WorldModel
from impact_oracle.oracle import ImpactOracle

__all__ = ["WorldModel", "ImpactOracle"]
