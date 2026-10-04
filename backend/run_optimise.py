"""Generate a week and optimise it end to end in Python: python3 run_optimise.py SEED POS [time_limit]"""
import json
import sys

from scheduler.cpsat import Settings
from scheduler.generator import generate_plant
from scheduler.optimise import optimise
from scheduler.plant import default_maintenance

seed, n = int(sys.argv[1]), int(sys.argv[2])
tl = float(sys.argv[3]) if len(sys.argv) > 3 else 60
sch, info = optimise(generate_plant(seed, n), default_maintenance(), Settings(time_limit=tl))
print(json.dumps(info))
