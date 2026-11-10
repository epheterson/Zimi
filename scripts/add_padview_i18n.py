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
    # The Almanac reference's rows for the pad view (tb_kn_pv_*): each assumption stated.
    "tb_kn_pv_view": [
        "Stand at the pad: where you stand",
        "Am Startplatz: wo Sie stehen",
        "En la plataforma: dónde te pones",
        "Au pas de tir : où l'on se tient",
        "Na plataforma: onde você fica",
        "У стартовой площадки: где вы стоите",
        "站在发射台旁：站位",
        "عند منصة الإطلاق: مكان وقوفك",
        "ליד משטח השיגור: היכן עומדים",
        "लॉन्च पैड के पास: आप कहाँ खड़े हैं",
    ],
    "tb_kn_pv_view_v": [
        "5 km from LC-39A on bearing 200° and 4 km from SLC-41 on 215°, eye 1.7 m over the ground, facing the pad. The distances are assumed (a press site's for that class of vehicle), not surveyed spots. The count starts at T−30 s on the mission's own clock.",
        "5 km von LC-39A in Richtung 200° und 4 km von SLC-41 in Richtung 215°, Augenhöhe 1,7 m, dem Startplatz zugewandt. Die Entfernungen sind angenommen (die eines Pressebereichs für diese Fahrzeugklasse), keine vermessenen Orte. Der Countdown beginnt bei T−30 s auf der eigenen Uhr der Mission.",
        "A 5 km de LC-39A en el rumbo 200° y a 4 km de SLC-41 en el 215°, ojos a 1,7 m del suelo, mirando a la plataforma. Las distancias son supuestas (las de una zona de prensa para esa clase de vehículo), no puntos medidos. La cuenta atrás empieza en T−30 s con el reloj propio de la misión.",
        "À 5 km de LC-39A au cap 200° et à 4 km de SLC-41 au cap 215°, les yeux à 1,7 m du sol, face au pas de tir. Les distances sont supposées (celles d'une zone presse pour cette classe de lanceur), pas des lieux relevés. Le compte à rebours commence à T−30 s sur l'horloge propre à la mission.",
        "A 5 km de LC-39A no rumo 200° e a 4 km de SLC-41 no 215°, olhos a 1,7 m do chão, de frente para a plataforma. As distâncias são supostas (as de uma área de imprensa para essa classe de veículo), não pontos medidos. A contagem começa em T−30 s no relógio próprio da missão.",
        "В 5 км от LC-39A по азимуту 200° и в 4 км от SLC-41 по азимуту 215°, глаза на высоте 1,7 м, лицом к площадке. Расстояния условные (как у пресс-центра для ракет такого класса), а не измеренные места. Отсчёт начинается с T−30 с по собственным часам миссии.",
        "在 LC-39A 方位 200° 处 5 公里、在 SLC-41 方位 215° 处 4 公里，视线离地 1.7 米，面向发射台。距离为假定值（同类运载器新闻观察点的距离），并非实测位置。倒计时按任务自己的时钟从 T−30 秒开始。",
        "على بعد 5 كم من LC-39A في الاتجاه 200° و4 كم من SLC-41 في الاتجاه 215°، وعلى ارتفاع 1.7 م عن الأرض، متجهًا إلى المنصة. المسافات مفترضة (مسافة منطقة الصحافة لهذه الفئة من المركبات) وليست مواقع مقيسة. يبدأ العدّ عند T−30 ث على ساعة المهمة نفسها.",
        "5 ק״מ מ-LC-39A בכיוון 200° ו-4 ק״מ מ-SLC-41 בכיוון 215°, גובה העיניים 1.7 מ׳, מול המשטח. המרחקים משוערים (מרחק אזור העיתונות לסוג כזה של משגר), לא מקומות שנמדדו. הספירה מתחילה ב-T−30 שנ׳ לפי שעון המשימה עצמה.",
        "LC-39A से 200° दिशा में 5 किमी और SLC-41 से 215° दिशा में 4 किमी, ज़मीन से 1.7 मी की आँख की ऊँचाई, पैड की ओर मुँह करके। दूरियाँ मानी हुई हैं (उस श्रेणी के यान के लिए प्रेस स्थल की दूरी), मापे हुए स्थान नहीं। गिनती मिशन की अपनी घड़ी पर T−30 से शुरू होती है।",
    ],
    "tb_kn_pv_climb": [
        "Stand at the pad: the first seconds of the climb",
        "Am Startplatz: die ersten Sekunden des Steigflugs",
        "En la plataforma: los primeros segundos del ascenso",
        "Au pas de tir : les premières secondes de la montée",
        "Na plataforma: os primeiros segundos da subida",
        "У стартовой площадки: первые секунды подъёма",
        "站在发射台旁：爬升的最初几秒",
        "عند منصة الإطلاق: الثواني الأولى من الصعود",
        "ליד משטח השיגור: השניות הראשונות של העלייה",
        "लॉन्च पैड के पास: चढ़ाई के पहले कुछ सेकंड",
    ],
    "tb_kn_pv_climb_v": [
        "The mission's table has a row every 10 to 20 s, too coarse for lift-off. From lift-off to the first row 15 s later (T+25 s for Apollo 11, T+22 s for Mars 2020) the climb is fitted to that row: straight up with a constant jerk, and the downrange drift a power of the time that meets the table's. The vehicle stands still until lift-off (T+0.6 s for Apollo 11) and clears the tower when its foot passes 122 m (about T+10 s).",
        "Die Tabelle der Mission hat alle 10 bis 20 s eine Zeile, zu grob für den Start. Vom Abheben bis zur ersten Zeile 15 s später (T+25 s bei Apollo 11, T+22 s bei Mars 2020) ist der Steigflug an diese Zeile angepasst: senkrecht mit konstantem Ruck, die Abdrift als Potenz der Zeit, die an die Tabelle anschließt. Bis zum Abheben (T+0,6 s bei Apollo 11) steht das Fahrzeug still und überwindet den Turm, wenn sein Fuß 122 m passiert (etwa T+10 s).",
        "La tabla de la misión tiene una fila cada 10 a 20 s, demasiado gruesa para el despegue. Desde el despegue hasta la primera fila 15 s después (T+25 s en Apolo 11, T+22 s en Mars 2020) el ascenso se ajusta a esa fila: vertical con sacudida constante, y la deriva horizontal como una potencia del tiempo que enlaza con la tabla. El vehículo está quieto hasta el despegue (T+0,6 s en Apolo 11) y supera la torre cuando su base pasa de 122 m (hacia T+10 s).",
        "La table de la mission a une ligne toutes les 10 à 20 s, trop grossière pour le décollage. Du décollage à la première ligne 15 s plus tard (T+25 s pour Apollo 11, T+22 s pour Mars 2020), la montée est ajustée à cette ligne : verticale à à-coup constant, la dérive vers l'aval suivant une puissance du temps qui rejoint la table. Le lanceur reste immobile jusqu'au décollage (T+0,6 s pour Apollo 11) et dégage la tour quand son pied dépasse 122 m (vers T+10 s).",
        "A tabela da missão tem uma linha a cada 10 a 20 s, grossa demais para a decolagem. Da decolagem até a primeira linha 15 s depois (T+25 s na Apollo 11, T+22 s na Mars 2020) a subida é ajustada a essa linha: vertical com arranque constante, e a deriva horizontal como uma potência do tempo que se junta à tabela. O veículo fica parado até a decolagem (T+0,6 s na Apollo 11) e passa a torre quando a base ultrapassa 122 m (cerca de T+10 s).",
        "В таблице миссии строка через 10–20 с — для старта слишком редко. От старта до первой строки через 15 с (T+25 с у «Аполлона-11», T+22 с у Mars 2020) подъём подогнан под неё: вертикально с постоянным рывком, снос вдоль трассы — степень времени, смыкающаяся с таблицей. Ракета неподвижна до старта (T+0,6 с у «Аполлона-11») и проходит башню, когда её основание пересекает 122 м (около T+10 с).",
        "任务表每 10 至 20 秒一行，对起飞来说太粗。从起飞到 15 秒后的第一行（阿波罗11号为 T+25 秒，火星2020为 T+22 秒），爬升按该行拟合：垂直上升、加加速度恒定，下行偏移取时间的幂次，使其与表相接。起飞前运载器静止（阿波罗11号为 T+0.6 秒），箭底越过 122 米时即越过塔架（约 T+10 秒）。",
        "في جدول المهمة صفّ كل 10 إلى 20 ثانية، وهذا خشن جدًا للإقلاع. من الإقلاع حتى أول صفّ بعد 15 ثانية (T+25 ث لأبولو 11 وT+22 ث لمارس 2020) يُلائم الصعود ذلك الصف: رأسيًا بقفزة ثابتة، والانجراف الأفقي قوة من الزمن تلتقي بالجدول. تبقى المركبة ساكنة حتى الإقلاع (T+0.6 ث لأبولو 11) وتتجاوز البرج حين تعبر قاعدتها 122 م (نحو T+10 ث).",
        "בטבלת המשימה שורה כל 10 עד 20 שניות, גסה מדי לשיגור. מהשיגור עד השורה הראשונה 15 שניות אחריו (T+25 שנ׳ באפולו 11, T+22 שנ׳ במארס 2020) העלייה מותאמת לשורה זו: אנכית בקפיצה קבועה, והסחיפה לאורך המסלול היא חזקה של הזמן שנפגשת עם הטבלה. הכלי עומד במקום עד השיגור (T+0.6 שנ׳ באפולו 11) ועובר את המגדל כשבסיסו חולף על פני 122 מ׳ (בערך T+10 שנ׳).",
        "मिशन की तालिका में हर 10 से 20 सेकंड पर एक पंक्ति है, जो प्रक्षेपण के लिए बहुत मोटी है। प्रक्षेपण से 15 सेकंड बाद की पहली पंक्ति तक (अपोलो 11 में T+25 से, मार्स 2020 में T+22 से) चढ़ाई उसी पंक्ति से मिलाई गई है: सीधे ऊपर स्थिर झटके के साथ, और आगे की ओर बहाव समय की एक घात जो तालिका से मिलती है। यान प्रक्षेपण तक स्थिर रहता है (अपोलो 11 में T+0.6 से) और जब उसका तल 122 मी पार करता है तब टावर पार करता है (लगभग T+10 से)।",
    ],
    "tb_kn_pv_pad": [
        "Stand at the pad: the launch structures",
        "Am Startplatz: die Startanlagen",
        "En la plataforma: las estructuras de lanzamiento",
        "Au pas de tir : les structures de lancement",
        "Na plataforma: as estruturas de lançamento",
        "У стартовой площадки: стартовые сооружения",
        "站在发射台旁：发射设施",
        "عند منصة الإطلاق: منشآت الإطلاق",
        "ליד משטח השיגור: מתקני השיגור",
        "लॉन्च पैड के पास: प्रक्षेपण संरचनाएँ",
    ],
    "tb_kn_pv_pad_v": [
        "LC-39A is the site model of the mobile launcher and umbilical tower (122 m, lightning mast to 134 m); its swing arms do not move. SLC-41 is boxes: a 48 × 40 × 9 m apron, a platform deck, a 56 m umbilical tower and four 100 m lightning masts. The proportions are approximate, not a replica.",
        "LC-39A ist das Standortmodell aus mobilem Starttisch und Nabelschnurturm (122 m, Blitzableiter bis 134 m); seine Schwenkarme bewegen sich nicht. SLC-41 besteht aus Quadern: ein Vorfeld von 48 × 40 × 9 m, ein Plattformdeck, ein 56 m hoher Nabelschnurturm und vier 100 m hohe Blitzschutzmasten. Die Proportionen sind angenähert, kein Nachbau.",
        "LC-39A es el modelo del sitio, con el lanzador móvil y la torre umbilical (122 m, pararrayos hasta 134 m); sus brazos no se mueven. SLC-41 son cajas: una explanada de 48 × 40 × 9 m, una plataforma, una torre umbilical de 56 m y cuatro mástiles pararrayos de 100 m. Las proporciones son aproximadas, no una réplica.",
        "LC-39A est le modèle du site, lanceur mobile et tour ombilicale (122 m, paratonnerre jusqu'à 134 m) ; ses bras ne bougent pas. SLC-41 est fait de boîtes : une aire de 48 × 40 × 9 m, un pont de plateforme, une tour ombilicale de 56 m et quatre mâts paratonnerres de 100 m. Les proportions sont approximatives, pas une réplique.",
        "LC-39A é o modelo do local, com o lançador móvel e a torre umbilical (122 m, para-raios até 134 m); seus braços não se movem. SLC-41 são caixas: uma área de 48 × 40 × 9 m, um deque de plataforma, uma torre umbilical de 56 m e quatro mastros para-raios de 100 m. As proporções são aproximadas, não uma réplica.",
        "LC-39A — модель площадки: подвижная пусковая платформа и башня обслуживания (122 м, громоотвод до 134 м); её фермы не двигаются. SLC-41 собрана из параллелепипедов: площадка 48 × 40 × 9 м, палуба платформы, башня обслуживания 56 м и четыре молниеотвода по 100 м. Пропорции приблизительные, это не копия.",
        "LC-39A 为场址模型，含移动发射平台与脐带塔（122 米，避雷针高至 134 米）；其摆臂不会动。SLC-41 由方块搭成：48 × 40 × 9 米的场坪、平台甲板、56 米的脐带塔和四根 100 米的避雷桅。比例为近似值，并非复制品。",
        "LC-39A هو نموذج الموقع للمنصة المتحركة وبرج الإمداد (122 م، وموصل الصواعق حتى 134 م)؛ ولا تتحرك أذرعه. أما SLC-41 فمن صناديق: ساحة 48 × 40 × 9 م وسطح منصة وبرج إمداد بارتفاع 56 م وأربعة صواري صواعق بارتفاع 100 م. النسب تقريبية وليست نسخة مطابقة.",
        "LC-39A הוא דגם האתר של משטח השיגור הנייד ומגדל הטבור (122 מ׳, מוט ברק עד 134 מ׳); זרועותיו אינן זזות. SLC-41 בנוי מקופסאות: רחבה של 48 × 40 × 9 מ׳, סיפון משטח, מגדל טבור של 56 מ׳ וארבעה תרנים נגד ברקים של 100 מ׳. היחסים משוערים, לא העתק.",
        "LC-39A साइट का मॉडल है, जिसमें चल प्रक्षेपक और नाभिनाल टावर (122 मी, तड़ित-रोधी छड़ 134 मी तक) हैं; उसकी भुजाएँ नहीं हिलतीं। SLC-41 डिब्बों से बना है: 48 × 40 × 9 मी का मैदान, मंच का डेक, 56 मी का टावर और 100 मी के चार तड़ित-रोधी खंभे। अनुपात अनुमानित हैं, प्रतिकृति नहीं।",
    ],
    "tb_kn_pv_exhaust": [
        "Stand at the pad: flame, cloud and trail",
        "Am Startplatz: Flamme, Wolke und Spur",
        "En la plataforma: llama, nube y estela",
        "Au pas de tir : flamme, nuage et traînée",
        "Na plataforma: chama, nuvem e rastro",
        "У стартовой площадки: пламя, облако и след",
        "站在发射台旁：火焰、云团与尾迹",
        "عند منصة الإطلاق: اللهب والسحابة والأثر",
        "ליד משטח השיגור: להבה, ענן ושובל",
        "लॉन्च पैड के पास: लौ, बादल और निशान",
    ],
    "tb_kn_pv_exhaust_v": [
        "The flame lengths are the mission's own (60 m for the Saturn V's first stage, longer as the air thins). The cloud at the pad, the sparks and the trail are puffs of assumed size, speed and life, not a fluid simulation: a trail puff every 12 m of the way, up to 30 km high. No weather is drawn: the sky is the clear one.",
        "Die Flammenlängen stammen aus der Mission selbst (60 m bei der ersten Stufe der Saturn V, länger in dünnerer Luft). Die Wolke am Startplatz, die Funken und die Spur sind Wölkchen von angenommener Größe, Geschwindigkeit und Lebensdauer, keine Strömungssimulation: alle 12 m Weg ein Spurwölkchen, bis 30 km Höhe. Wetter wird nicht gezeichnet: der Himmel ist der klare.",
        "Los largos de la llama son los de la propia misión (60 m en la primera etapa del Saturn V, mayores al enrarecerse el aire). La nube de la plataforma, las chispas y la estela son bocanadas de tamaño, velocidad y vida supuestos, no una simulación de fluidos: una bocanada de estela cada 12 m del camino, hasta 30 km de altura. No se dibuja el tiempo: el cielo es el despejado.",
        "Les longueurs de flamme sont celles de la mission (60 m pour le premier étage du Saturn V, plus longues quand l'air s'amincit). Le nuage au pas de tir, les étincelles et la traînée sont des bouffées de taille, vitesse et durée de vie supposées, pas une simulation de fluide : une bouffée de traînée tous les 12 m de trajet, jusqu'à 30 km d'altitude. Aucune météo n'est dessinée : le ciel est le ciel dégagé.",
        "Os comprimentos da chama são os da própria missão (60 m no primeiro estágio do Saturn V, maiores com o ar rarefeito). A nuvem na plataforma, as faíscas e o rastro são baforadas de tamanho, velocidade e vida supostos, não uma simulação de fluidos: uma baforada de rastro a cada 12 m do caminho, até 30 km de altura. Não se desenha o tempo: o céu é o limpo.",
        "Длины пламени — из самой миссии (60 м у первой ступени «Сатурна-5», больше в разреженном воздухе). Облако у площадки, искры и след — клубы условного размера, скорости и срока жизни, а не моделирование течения: клуб следа каждые 12 м пути, до высоты 30 км. Погода не рисуется: небо ясное.",
        "火焰长度取自任务本身（土星五号一级为 60 米，空气稀薄时更长）。发射台处的云团、火花与尾迹是大小、速度和寿命均为假定的烟团，并非流体模拟：沿途每 12 米一个尾迹烟团，直至 30 公里高。不绘制天气：天空为晴空。",
        "أطوال اللهب هي أطوال المهمة نفسها (60 م للمرحلة الأولى من ساتورن 5، وتطول كلما رقّ الهواء). أما السحابة عند المنصة والشرر والأثر فنفثات بحجم وسرعة وعمر مفترضة وليست محاكاة للموائع: نفثة أثر كل 12 م من المسار حتى ارتفاع 30 كم. لا يُرسم الطقس: السماء صافية.",
        "אורכי הלהבה הם אלה של המשימה עצמה (60 מ׳ בשלב הראשון של סטורן 5, ארוכים יותר כשהאוויר דליל). הענן ליד המשטח, הניצוצות והשובל הם פופים בגודל, מהירות וחיים משוערים, לא סימולציית זורמים: פוף שובל כל 12 מ׳ מהמסלול, עד גובה 30 ק״מ. מזג אוויר אינו מצויר: השמיים בהירים.",
        "लौ की लंबाई मिशन की अपनी है (सैटर्न 5 के पहले चरण में 60 मी, हवा पतली होने पर और लंबी)। पैड का बादल, चिंगारियाँ और निशान मानी हुई माप, गति और आयु के कश हैं, तरल का अनुकरण नहीं: रास्ते के हर 12 मी पर निशान का एक कश, 30 किमी ऊँचाई तक। मौसम नहीं दिखाया जाता: आकाश साफ़ है।",
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
