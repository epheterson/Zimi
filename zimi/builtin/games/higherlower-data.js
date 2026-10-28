/* Higher or Lower: the built-in numbers, for a page with no library behind it. Plain data, no logic. Rounded figures
   (about 2023 for people, as the sources of the public lists give them); the game shows them rounded, too.
   COUNTRIES: [name, people in millions, area in thousands of square kilometres]
   MOUNTAINS: [name, height in metres]    RIVERS: [name, length in kilometres] */
(function (root) {
  root.HIGHLOW_COUNTRIES = [
    ['China', 1411, 9597], ['India', 1429, 3287], ['United States', 335, 9834], ['Indonesia', 277, 1905], ['Pakistan', 240, 882],
    ['Nigeria', 224, 924], ['Brazil', 216, 8516], ['Bangladesh', 173, 148], ['Russia', 144, 17098], ['Mexico', 128, 1964],
    ['Japan', 124, 378], ['Ethiopia', 126, 1104], ['Philippines', 117, 300], ['Egypt', 112, 1002], ['Vietnam', 99, 331],
    ['Turkey', 85, 784], ['Germany', 84, 358], ['Thailand', 72, 513], ['United Kingdom', 68, 244], ['France', 68, 644],
    ['Italy', 59, 301], ['South Africa', 60, 1221], ['Tanzania', 67, 947], ['Kenya', 55, 580], ['Spain', 48, 506],
    ['Argentina', 46, 2780], ['Canada', 40, 9985], ['Poland', 37, 313], ['Australia', 26, 7692], ['Saudi Arabia', 36, 2150],
    ['Peru', 34, 1285], ['Netherlands', 18, 42], ['Chile', 20, 756], ['Greece', 10, 132], ['Portugal', 10, 92],
    ['Sweden', 10.5, 450], ['Norway', 5.5, 385], ['Ireland', 5.2, 70], ['New Zealand', 5.2, 268], ['Iceland', 0.38, 103],
    ['Singapore', 5.9, 0.73], ['Switzerland', 8.8, 41], ['Cuba', 11, 110], ['Algeria', 45, 2382], ['Kazakhstan', 20, 2725],
    ['Mongolia', 3.4, 1564]
  ];
  root.HIGHLOW_MOUNTAINS = [
    ['Mount Everest', 8849], ['K2', 8611], ['Kangchenjunga', 8586], ['Lhotse', 8516], ['Makalu', 8485], ['Denali', 6190],
    ['Aconcagua', 6961], ['Kilimanjaro', 5895], ['Mont Blanc', 4806], ['The Matterhorn', 4478], ['Mount Elbrus', 5642],
    ['Mount Fuji', 3776], ['Ben Nevis', 1345], ['Mount Kosciuszko', 2228], ['Mount Rainier', 4392], ['Mount Whitney', 4421],
    ['Mount Olympus', 2918], ['Table Mountain', 1085], ['Mount Vesuvius', 1281], ['Mauna Kea', 4207], ['Aoraki Mount Cook', 3724],
    ['Puncak Jaya', 4884], ['Mount Kenya', 5199], ['Mount Etna', 3357]
  ];
  root.HIGHLOW_RIVERS = [
    ['Nile', 6650], ['Amazon', 6400], ['Yangtze', 6300], ['Yellow River', 5464], ['Congo', 4700], ['Mekong', 4350], ['Lena', 4400],
    ['Niger', 4180], ['Volga', 3530], ['Indus', 3180], ['Danube', 2850], ['Euphrates', 2800], ['Ganges', 2525], ['Zambezi', 2574],
    ['Murray', 2508], ['Tigris', 1850], ['Rhine', 1230], ['Seine', 777], ['Loire', 1006], ['Elbe', 1094], ['Thames', 346]
  ];
})(this);
