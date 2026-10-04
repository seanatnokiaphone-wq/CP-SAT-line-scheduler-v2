"""mulberry32, bit-exact with the v49 JavaScript (`mulberry32` in App-v49)."""

M32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & M32


def mulberry32(seed: int):
    a = seed & M32

    def rng() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & M32
        t = _imul(a ^ (a >> 15), 1 | a)
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) & M32) ^ t
        return ((t ^ (t >> 14)) & M32) / 4294967296

    return rng


def js_round(x: float) -> int:
    """Math.round: halves go up (Python's round() goes to even)."""
    import math
    return math.floor(x + 0.5)
