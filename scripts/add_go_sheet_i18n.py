#!/usr/bin/env python3
"""Add the 3D view's Go to sheet strings (the small-worlds pill, the grid and list toggle) to the ten interface languages.

python3 scripts/add_go_sheet_i18n.py
"""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
I18N = os.path.join(ROOT, "zimi", "static", "i18n")
LANGS = ["en", "de", "es", "fr", "pt", "ru", "zh", "ar", "he", "hi"]

# key: english, german, spanish, french, portuguese, russian, chinese, arabic, hebrew, hindi
STRINGS = {
    "alm_go_small": [
        "Small worlds",
        "Kleine Welten",
        "Mundos menores",
        "Petits mondes",
        "Mundos menores",
        "Малые миры",
        "小天体",
        "عوالم صغيرة",
        "עולמות קטנים",
        "छोटे संसार",
    ],
    "go_view_grid": [
        "Grid",
        "Raster",
        "Cuadrícula",
        "Grille",
        "Grade",
        "Сетка",
        "网格",
        "شبكة",
        "רשת",
        "ग्रिड",
    ],
    "go_view_list": [
        "List",
        "Liste",
        "Lista",
        "Liste",
        "Lista",
        "Список",
        "列表",
        "قائمة",
        "רשימה",
        "सूची",
    ],
}


def main():
    for lang in LANGS:
        path = os.path.join(I18N, lang + ".json")
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        for key, vals in STRINGS.items():
            data[key] = vals[LANGS.index(lang)]
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")


if __name__ == "__main__":
    main()
