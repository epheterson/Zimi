"""PyInstaller runtime hook: set pythonnet to use CoreCLR on Windows."""
import os
import platform

if platform.system() == "Windows":
    os.environ.setdefault("PYTHONNET_RUNTIME", "coreclr")
