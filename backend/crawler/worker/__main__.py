"""Allow running as: python -m worker"""
import asyncio
from .main import main

asyncio.run(main())
