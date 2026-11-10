#!/usr/bin/env python3
"""Add Stand at the pad's strings to the ten interface languages (zimi/static/i18n/*.json). Idempotent: edit STRINGS, run again.

python3 scripts/add_padview_i18n.py
"""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
I18N = os.path.join(ROOT, "zimi", "static", "i18n")
LANGS = ["en", "de", "es", "fr", "pt", "ru", "zh", "ar", "he", "hi"]

# key: english, german, spanish, french, portuguese, russian, chinese, arabic, hebrew, hindi
STRINGS = {
    "alm_pad_at": [
        "Stand at the pad",
        "Am Startplatz stehen",
        "Ponte en la plataforma",
        "Se tenir près du pas de tir",
        "Ficar na plataforma",
        "Встать у стартовой площадки",
        "站在发射台旁",
        "قف عند منصة الإطلاق",
        "לעמוד ליד משטח השיגור",
        "लॉन्च पैड के पास खड़े हों",
    ],
    "alm_pad_back": [
        "Back to {where}",
        "Zurück zu {where}",
        "Volver a {where}",
        "Retour à {where}",
        "Voltar a {where}",
        "Назад: {where}",
        "返回{where}",
        "العودة إلى {where}",
        "חזרה אל {where}",
        "{where} पर लौटें",
    ],
    "alm_pad_restart": [
        "Back to T−30",
        "Zurück zu T−30",
        "Volver a T−30",
        "Revenir à T−30",
        "Voltar a T−30",
        "Вернуться к T−30",
        "回到 T−30",
        "العودة إلى T−30",
        "חזרה ל-T−30",
        "T−30 पर लौटें",
    ],
    "alm_pad_closer": [
        "Walk closer",
        "Näher herangehen",
        "Acercarse",
        "Se rapprocher",
        "Chegar mais perto",
        "Подойти ближе",
        "走近些",
        "اقترب",
        "התקרבות",
        "और पास जाएँ",
    ],
    "alm_pad_ignition": [
        "Ignition",
        "Zündung",
        "Encendido",
        "Allumage",
        "Ignição",
        "Зажигание",
        "点火",
        "الإشعال",
        "הצתה",
        "इग्निशन",
    ],
    "alm_pad_cleared": [
        "Tower cleared",
        "Turm überwunden",
        "Torre superada",
        "Tour dégagée",
        "Torre livre",
        "Башня пройдена",
        "越过塔架",
        "تجاوز البرج",
        "המגדל נעבר",
        "टावर पार",
    ],
    "alm_pad_follow": [
        "Follow the flight",
        "Dem Flug folgen",
        "Seguir el vuelo",
        "Suivre le vol",
        "Seguir o voo",
        "Следить за полётом",
        "跟随飞行",
        "تابع الرحلة",
        "מעקב אחר הטיסה",
        "उड़ान का पीछा करें",
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
