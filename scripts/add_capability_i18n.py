#!/usr/bin/env python3
"""Add the capability levels' strings (the 3D view's gear) to the ten interface languages (zimi/static/i18n/*.json).

python3 scripts/add_capability_i18n.py
"""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
I18N = os.path.join(ROOT, "zimi", "static", "i18n")
LANGS = ["en", "de", "es", "fr", "pt", "ru", "zh", "ar", "he", "hi"]

# key: english, german, spanish, french, portuguese, russian, chinese, arabic, hebrew, hindi
STRINGS = {
    "cap_title": [
        "Performance",
        "Leistung",
        "Rendimiento",
        "Performances",
        "Desempenho",
        "Производительность",
        "性能",
        "الأداء",
        "ביצועים",
        "प्रदर्शन",
    ],
    "cap_auto": [
        "Auto",
        "Auto",
        "Auto",
        "Auto",
        "Auto",
        "Авто",
        "自动",
        "تلقائي",
        "אוטומטי",
        "स्वचालित",
    ],
    "cap_light": [
        "Light",
        "Leicht",
        "Ligero",
        "Léger",
        "Leve",
        "Лёгкий",
        "轻量",
        "خفيف",
        "קל",
        "हल्का",
    ],
    "cap_full": [
        "Full",
        "Voll",
        "Completo",
        "Complet",
        "Completo",
        "Полный",
        "完整",
        "كامل",
        "מלא",
        "पूर्ण",
    ],
    "cap_hint_auto": [
        "Chosen for this device, and lowered if frames run slow",
        "Für dieses Gerät gewählt und gesenkt, wenn Bilder stocken",
        "Elegido para este dispositivo y reducido si los fotogramas van lentos",
        "Choisi pour cet appareil, et abaissé si les images saccadent",
        "Escolhido para este dispositivo e reduzido se os quadros ficarem lentos",
        "Выбирается под это устройство и снижается, если кадры идут медленно",
        "按本设备选择，帧率过低时自动降低",
        "يُختار لهذا الجهاز ويُخفَّض إذا تباطأت الإطارات",
        "נבחר למכשיר הזה ויורד אם הפריימים איטיים",
        "इस डिवाइस के लिए चुना गया, फ़्रेम धीमे हों तो घटाया जाता है",
    ],
    "cap_hint_light": [
        "Fewer effects, for slower devices",
        "Weniger Effekte, für langsamere Geräte",
        "Menos efectos, para dispositivos lentos",
        "Moins d'effets, pour les appareils lents",
        "Menos efeitos, para dispositivos mais lentos",
        "Меньше эффектов, для медленных устройств",
        "减少效果，适合较慢的设备",
        "تأثيرات أقل للأجهزة الأبطأ",
        "פחות אפקטים, למכשירים איטיים",
        "कम प्रभाव, धीमे डिवाइस के लिए",
    ],
    "cap_hint_full": [
        "Every effect, as sharp as this screen allows",
        "Alle Effekte, so scharf, wie der Bildschirm erlaubt",
        "Todos los efectos, tan nítido como permita la pantalla",
        "Tous les effets, aussi net que l'écran le permet",
        "Todos os efeitos, tão nítido quanto a tela permitir",
        "Все эффекты, максимально чётко для этого экрана",
        "全部效果，按屏幕所能达到的最高清晰度",
        "كل التأثيرات بأعلى وضوح تسمح به الشاشة",
        "כל האפקטים, בחדות המרבית שהמסך מאפשר",
        "सभी प्रभाव, स्क्रीन जितना अनुमति दे उतने स्पष्ट",
    ],
    "cap_level_low": [
        "This device runs the light version",
        "Dieses Gerät nutzt die leichte Fassung",
        "Este dispositivo usa la versión ligera",
        "Cet appareil utilise la version légère",
        "Este dispositivo usa a versão leve",
        "Это устройство работает в лёгком режиме",
        "此设备使用轻量版",
        "يعمل هذا الجهاز بالنسخة الخفيفة",
        "המכשיר הזה מריץ את הגרסה הקלה",
        "यह डिवाइस हल्का संस्करण चलाता है",
    ],
    "cap_level_standard": [
        "This device runs the standard version",
        "Dieses Gerät nutzt die Standardfassung",
        "Este dispositivo usa la versión estándar",
        "Cet appareil utilise la version standard",
        "Este dispositivo usa a versão padrão",
        "Это устройство работает в стандартном режиме",
        "此设备使用标准版",
        "يعمل هذا الجهاز بالنسخة القياسية",
        "המכשיר הזה מריץ את הגרסה הרגילה",
        "यह डिवाइस मानक संस्करण चलाता है",
    ],
    "cap_level_high": [
        "This device runs the full version",
        "Dieses Gerät nutzt die volle Fassung",
        "Este dispositivo usa la versión completa",
        "Cet appareil utilise la version complète",
        "Este dispositivo usa a versão completa",
        "Это устройство работает в полном режиме",
        "此设备使用完整版",
        "يعمل هذا الجهاز بالنسخة الكاملة",
        "המכשיר הזה מריץ את הגרסה המלאה",
        "यह डिवाइस पूर्ण संस्करण चलाता है",
    ],
    "cap_online": [
        "Better online",
        "Besser online",
        "Mejor en línea",
        "Mieux en ligne",
        "Melhor online",
        "Лучше онлайн",
        "联网更好",
        "أفضل عبر الإنترنت",
        "טוב יותר ברשת",
        "ऑनलाइन बेहतर",
    ],
    "cap_o_satellites": [
        "Satellite orbits",
        "Satellitenbahnen",
        "Órbitas de satélites",
        "Orbites des satellites",
        "Órbitas de satélites",
        "Орбиты спутников",
        "卫星轨道",
        "مدارات الأقمار",
        "מסלולי לוויינים",
        "उपग्रह कक्षाएँ",
    ],
    "cap_o_almanac_hd": [
        "HD tiles",
        "HD-Kacheln",
        "Teselas HD",
        "Tuiles HD",
        "Blocos HD",
        "HD-плитки",
        "高清瓦片",
        "بلاطات عالية الدقة",
        "אריחי HD",
        "HD टाइलें",
    ],
    "cap_o_streetzim": [
        "Maps",
        "Karten",
        "Mapas",
        "Cartes",
        "Mapas",
        "Карты",
        "地图",
        "الخرائط",
        "מפות",
        "मानचित्र",
    ],
    "cap_static": [
        "The 3D view is off on this device. Choose Full in the gear to try it.",
        "Die 3D-Ansicht ist auf diesem Gerät aus. Wähle im Zahnrad Voll, um sie zu versuchen.",
        "La vista 3D está desactivada en este dispositivo. Elige Completo en el engranaje para probarla.",
        "La vue 3D est désactivée sur cet appareil. Choisissez Complet dans la roue pour l'essayer.",
        "A vista 3D está desligada neste dispositivo. Escolha Completo na engrenagem para tentar.",
        "На этом устройстве 3D-вид отключён. Выберите «Полный» в настройках, чтобы попробовать.",
        "此设备已关闭 3D 视图。在齿轮中选择“完整”即可尝试。",
        "عرض ثلاثي الأبعاد متوقف على هذا الجهاز. اختر «كامل» من الترس لتجربته.",
        "התצוגה התלת־ממדית כבויה במכשיר הזה. בחרו מלא בגלגל השיניים כדי לנסות.",
        "इस डिवाइस पर 3D दृश्य बंद है। आज़माने के लिए गियर में पूर्ण चुनें।",
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
