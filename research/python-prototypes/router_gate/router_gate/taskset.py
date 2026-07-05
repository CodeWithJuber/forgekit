"""A labeled task set for evaluating the router and the gate.

Each task carries GOLD labels assigned by hand:
  gold_tier   : the cheapest tier a competent engineer would say is *sufficient*
                ("cheap"|"mid"|"premium"). This is the routing target.
  gold_ask    : True if the request is under-specified enough that asking a
                clarifying question is the correct action (the gate target).

This is a DEMONSTRATION set (30 tasks), not a benchmark. It is deliberately small,
hand-labeled, and self-built -- exactly the honesty the paper demands. The gold
labels encode a defensible engineering judgment, not ground truth; they are stated
so a reader can disagree item by item.
"""

# (task_text, gold_tier, gold_ask)
TASKS = [
    # ---- trivial, well-specified -> cheap, no ask ----
    ("Write a Python function is_even(n) that returns True if n is even. Example: is_even(4) -> True.", "cheap", False),
    ("Reverse a string in Python. Input: 'abc' -> Output: 'cba'. Provide the function.", "cheap", False),
    ("Write factorial(n) in Python returning n!. factorial(5) -> 120.", "cheap", False),
    ("Capitalize the first letter of each word in a string. Input 'hello world' -> 'Hello World'.", "cheap", False),
    ("Return the sum of a list of integers. sum_list([1,2,3]) -> 6. Python.", "cheap", False),
    ("Write a function that checks if a number is prime. is_prime(7) -> True, is_prime(8) -> False. Python.", "cheap", False),
    ("Convert a temperature in Celsius to Fahrenheit. c_to_f(0) -> 32.0. Python function.", "cheap", False),
    ("Count vowels in a string. count_vowels('apple') -> 2. Python.", "cheap", False),

    # ---- moderate, well-specified -> mid, no ask ----
    ("Implement an LRU cache class in Python with get(key) and put(key, value), capacity fixed at construction, O(1) operations. Include a docstring.", "mid", False),
    ("Parse a CSV string into a list of dicts using the header row as keys. Handle quoted fields containing commas. Python, standard library only.", "mid", False),
    ("Write a function that merges two sorted integer lists into one sorted list without using sorted(). Return the merged list. Python.", "mid", False),
    ("Implement debounce(fn, wait_ms) in JavaScript that delays calling fn until wait_ms has elapsed since the last call. Return the debounced function.", "mid", False),
    ("Given a binary tree node class with .left/.right/.val, write an in-order traversal returning a list of values. Python.", "mid", False),
    ("Validate an email address with a regex in Python and return True/False. Must reject 'a@b' and accept 'a@b.com'.", "mid", False),
    ("Write a retry decorator in Python: retry(times=3, delay=0.1) that re-runs the wrapped function on exception up to `times`, then re-raises.", "mid", False),

    # ---- complex, well-specified -> premium, no ask ----
    ("Design and implement a thread-safe bounded blocking queue in Python supporting put() and get() from multiple producer and consumer threads, with proper condition-variable signaling and no busy-waiting. Include tests for the empty and full boundary conditions.", "premium", False),
    ("Implement Dijkstra's shortest-path algorithm on a weighted directed graph given as an adjacency dict, returning the distance map and the predecessor map. Handle unreachable nodes. Optimize with a binary heap. Python.", "premium", False),
    ("Refactor a synchronous data pipeline into an async architecture: design the module boundaries, define back-pressure between stages, ensure at-least-once processing under failure, and document the consistency trade-offs. Target Python asyncio.", "premium", False),
    ("Write a recursive-descent parser for a small arithmetic grammar (numbers, + - * /, parentheses, correct precedence and associativity) that returns an AST, plus an evaluator. Include error handling for malformed input. Python.", "premium", False),
    ("Implement a distributed rate limiter using a token-bucket algorithm backed by Redis, correct under concurrent access from multiple app instances, with configurable rate and burst. Explain the atomicity guarantees. Python.", "premium", False),
    ("Design a schema migration system that applies and rolls back ordered migrations, records applied state, is idempotent on partial failure, and is safe to run concurrently from multiple deployers. Describe the locking strategy and implement the core. Python + SQL.", "premium", False),

    # ---- under-specified (any complexity) -> gold_ask = True ----
    ("Fix the bug.", "cheap", True),
    ("Make the API faster.", "mid", True),
    ("Add authentication to the app.", "premium", True),
    ("Write a function to process the data and handle everything appropriately.", "mid", True),
    ("Refactor this module to be cleaner.", "mid", True),
    ("Build the reporting feature the way we discussed.", "premium", True),
    ("Optimize it.", "mid", True),
    ("Integrate the payment thing and make it work properly.", "premium", True),
    ("Update the config as needed and clean it up.", "cheap", True),
]


def load():
    """Return the task set as a list of dicts."""
    return [{"task": t, "gold_tier": gt, "gold_ask": ga} for (t, gt, ga) in TASKS]
