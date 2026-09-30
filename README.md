# Sandbox Rabbit

Un bac à sable cellulaire (« falling sand ») qui tourne entièrement dans le
navigateur, servi par un Worker Cloudflare qui héberge aussi l'API.

Quarante-huit matières, rangées en familles repliables (terrain, liquides,
inflammable, explosifs, froid, vivant, électricité, gaz, outils) : `sable / eau /
pierre / bois / huile / goudron / alcool / acide / lave / plante / lapin / héros / feu / glace /
neige / azote liquide / sel / eau salée / poudre / TNT / nitroglycérine / C4 /
mine / thermite / uranium / grisou / retombées / pétrole / graine / nanites / verre / verre fondu / mercure /
cire / cire fondue / bougie / boue / braise / métal / pile / interrupteur / étincelle /
ciment / limaille / aimant / source / fumée / vapeur`, pinceau réglable, vue thermique, pause & pas à pas, galerie de
mondes partagés, bac multijoueur.

### Ce qui se passe quand on mélange

| Règle | Effet |
| --- | --- |
| Chaleur | Un champ de température est diffusé à chaque tick. L'eau bout à 100 °C et gèle à 0, la glace fond, le sable vitrifie près de la lave, l'huile s'auto-enflamme. Une seule loi, tous les changements d'état en découlent (`boil` / `freeze` dans `materials.ts`). |
| TNT & poudre | La flamme déclenche l'explosion, l'explosion rallume les charges voisines : ça part en chaîne. |
| Souffle | Une explosion ne se contente plus d'effacer un disque : elle **projette**. Chaque cellule part le long de son rayon et se dépose sur la dernière place libre rencontrée — les débris d'une charge enterrée ressortent donc par le cratère au lieu de s'écraser dans la roche voisine, et deux projections ne peuvent pas atterrir au même endroit, donc la matière est conservée. Le disque est traité du bord vers le centre, pour que chacune parte vers une place déjà libérée. Ce qui n'a nulle part où aller (un mur plein) est pulvérisé comme avant : sans ce repli, une charge ne percerait plus rien. À l'air libre, un souffle détruit ainsi deux fois moins de matière qu'enterré — il la déplace. |
| Pression & vent | Une explosion laisse une **onde de pression** dans l'air jusqu'à trois fois son rayon, plus forte au centre : fumée, vapeur et flammes sont chassées vers l'extérieur, puis la pression retombe en une seconde environ. L'eau jetée sur la lave se vaporise en bouffée. Seul l'air (le vide et les gaz) porte la pression ; la pierre, le sable ou l'eau l'arrêtent comme un mur. Le calcul ne tourne que là où un souffle a laissé de la pression : un bac sans explosion ne le paie pas. |
| Explosifs | Cinq matières, cinq **déclencheurs** différents — c'est là qu'est la variété, pas dans le rayon de souffle. La nitroglycérine obéit au choc : `life` compte ses cellules de chute et l'atterrissage au-delà de quatre détonne, la poser à la main ne risque rien. Le C4 ignore le feu et n'obéit qu'à l'étincelle : une charge amorcée par la détonation d'une voisine (`life` = 1) fait partir un mur entier, ce qui donne enfin un usage à la pile et à l'interrupteur. Le grisou obéit au volume : gaz `flammable` 1, il s'accumule au plafond puis toute la nappe part d'un coup. La mine obéit au poids, mais seulement de ce qui coule (`kind` poudre ou liquide) : on peut donc la murer. |
| Nucléaire | Le seul explosif sans mise à feu : **sa masse est son déclencheur**. Un grain d'uranium isolé se contente de tiédir (60 °C, c'est un chauffage) ; dès qu'une cellule a trois voisins d'uranium, elle s'emballe — un compteur monte dans `life`, la température avec lui (jusqu'à ~750 °C, la matière pâlit et la vue thermique voit venir le coup), et au bout de 120 ticks c'est un souffle de rayon 16. Casser le tas fait redescendre le compteur : c'est la seule parade, et elle se joue à la souris. Ce qui reste distingue le nucléaire d'un gros TNT : les **retombées**, un gaz qui traîne 250 ticks et où rien de vivant ne tient. |
| Pétrole | Il ne brûle pas. Une flamme posée dessus ne fait rien du tout — il faut le **chauffer** (200 °C, c'est-à-dire la lave ou la thermite, pas une allumette) et il se change alors en grisou. C'est le gaz qui explose, pas le liquide : une poche scellée sous la roche se remplit, et attend l'étincelle. |
| Thermite | L'anti-explosif : elle ne souffle rien, elle perce. Elle impose 2800 °C sur place pendant 150 ticks, ce qui liquéfie la pierre (`boil` à 1400 °C, hors de portée de la lave qui plafonne à 800 °C dans la roche voisine), et elle continue de tomber en brûlant — densité 8, elle passe sous la lave qu'elle vient de créer. D'où un vrai puits, et pas un cratère. |
| Sel | Se dissout dans l'eau (eau salée, plus lourde, gèle à -18 °C) et fait fondre la glace. |
| Graine | Tombe comme une poudre, germe en plante au contact de l'eau. |
| Lapin | La première créature, et elle n'apprend rien : une poignée de règles fixes. **Taille fixe** : un lapin, ce sont neuf cellules de profil (oreille, tête, œil, dos, queue, pattes), qu'un clic pose en entier quel que soit le rayon du pinceau, et que son cœur déplace d'un bloc — un pas, une marche à grimper, un demi-tour. Le cœur porte la satiété dans `life` : elle baisse toute seule (un quart de minute sans manger et il meurt), il broute ce qu'il a devant le museau ou sous les pattes et, affamé, part vers la plante qu'il voit à huit cellules. Il fuit la chaleur vers le côté le plus frais : `temp` étant diffusé, l'air chauffe avant que la flamme n'arrive, il la sent venir. Il ne marche que sur du vide ; tombé dans l'eau, il coule (l'eau déplacée remonte) et se noie. Deux lapins repus à quelques cellules l'un de l'autre font un petit de la même taille, ce qui coûte deux repas : la population suit les plantes au lieu d'exploser. Tout lui arrive en entier : cuit au-delà de 110 °C il flambe, gelé sous -25 °C c'est un lapin de glace, et une patte arrachée (souffle, acide, nanites, gomme) le fait disparaître. Les retombées le tuent, une mine sent ses pattes. |
| Héros | Le seul qu'on pilote : sept cellules posées d'un clic (Vivant → Héros), ou au centre d'un nouveau monde. Q/D ou flèches pour marcher (il grimpe les marches d'une cellule), Z pour sauter — et nager, car il coule dans l'eau et s'y noie en quelques secondes —, S pour creuser sous ses pieds, E devant lui, R pour poser la matière choisie — une marche devant ses pieds, qu'il gravit en avançant, ou avec Z un pilier sous lui. Il creuse tout ce qui est solide sauf le métal, et ne pose que du solide (ni gaz, ni liquide, ni nanites, étincelle, braise ou source). Il a une santé : chaleur, froid et apnée le blessent au lieu de le tuer net (moins d'une seconde dans les flammes, trois d'apnée), et il guérit au calme en une demi-minute ; acide, feu ou souffle qui lui arrachent un membre le tuent toujours d'un coup. Chaque héros a un nom tiré d'une liste, qu'on change dans l'encadré Héros du panneau et que le monde sauvegardé garde ; il naît à 18 ans et prend un an par journée du cycle. L'encadré montre aussi sa santé, sa température et ce qu'il a creusé et posé — le tout rangé dans les cellules de son corps. Avec plusieurs héros, un seul obéit : le dernier posé, ou celui qu'on choisit avec C (ou « Héros suivant » dans l'encadré Héros) ; les autres attendent, et s'il meurt on passe au suivant. Dans les deux vues de côté, un cadre lumineux cerne le héros piloté — celui que suivent la caméra et la fiche. V fait défiler trois vues : de côté, de côté avec un encadré de ce qu'il voit, ou à la première personne — son monde est un plan, son œil n'en reçoit qu'une ligne, du ciel à ses pieds, plus sombre au loin. La caméra le suit, zoomée à son apparition ; glisser au clic du milieu (ou à deux doigts) la décroche sans le supprimer, un clic du milieu sans bouger la raccroche. Ces touches sont celles d'origine, réassignables (voir Raccourcis). Ses commandes sont des gestes : le rejeu les rejoue, un invité de salon pilote le héros de l'hôte. |
| Nanites | Dévorent la matière et se répliquent, puis meurent de vieillesse. Seul le verre les arrête : on peut construire un bocal. |
| Source | Émet en continu la dernière matière sélectionnée avant elle (stockée dans `life`). |
| Feu | `flammable` est une probabilité **par tick et par flamme voisine** : la poudre part instantanément (1), l'huile s'embrase (0,6), la graine crépite (0,05), le bois met une seconde à prendre (0,02). C'est le seul réglage de vitesse de propagation. |
| Mercure | Densité 13 : passe sous tout, même sous la pierre en train de couler. Gèle en métal à -39 °C, s'évapore à 357. |
| Cire & bougie | La cire fond à 60 °C, coule, puis redurcit sous 55 : on peut faire couler une bougie. La bougie, elle, s'allume au contact d'une flamme (`life` = mèche allumée), réalimente sa flamme indéfiniment, et l'eau la souffle. |
| Azote liquide | `heat` -190 : il gèle l'eau en glace au contact, fige tout ce qu'il touche, et s'évapore en buée dès qu'il retrouve plus chaud que -60 °C. Le pendant froid de la lave, sauf qu'il ne dure pas. |
| Neige | Poudre froide (`heat` -12) plus légère que l'eau : elle s'amoncelle, flotte, et fond dès 2 °C. |
| Boue | Liquide lent et lourd qui engloutit, et sèche en sable au-dessus de 60 °C. |
| Braise | Le bois brûlé passe une fois sur deux par la braise au lieu de disparaître : le foyer continue de chauffer (350 °C) et de rallumer bien après la flamme. |
| Électricité | L'étincelle ne circule que dans le métal, à la vitesse d'un tick. Elle enflamme et fait sauter le TNT à l'autre bout du fil. Le métal traversé se repose 8 ticks, sinon l'étincelle rebondirait sans fin. |
| Pile & interrupteur | La pile envoie une étincelle dans le métal voisin tous les 24 ticks, sans fin. L'interrupteur relaie l'étincelle quand il est fermé (il s'éclaircit) et coupe le circuit quand il est ouvert : cliquer dessus, avec l'interrupteur sélectionné, le bascule. De quoi câbler un vrai circuit plutôt qu'une étincelle lâchée à la main. |
| Goudron | Huile lourde, `spread` 0 : elle coule à peine et brûle longtemps. |
| Alcool | Le plus léger des liquides : il flotte sur tout, s'enflamme d'un rien (0,9) et s'évapore dès 40 °C. |
| Verre fondu | Le verre refond au-dessus de 700 °C, coule, puis se fige sous 600 : sable → verre → verre fondu → verre, sans une ligne de règle dans le moteur. |
| Vue thermique | Case à cocher ou touche `h` : affiche `temp` au lieu de la matière, bleu pour le froid, corps noir jusqu'au blanc à 1200 °C. |
| Éclairage | Case à cocher, active par défaut : le feu, la lave, les braises, l'uranium et tout ce qui dépasse 450 °C éclairent le bac ; la pierre fait de l'ombre, l'eau atténue, le verre laisse passer. Éclairage global en *radiance cascades*, calculé par la carte graphique à chaque frame (WebGL2 seulement). |
| Lumière | Ce qui est chaud éclaire ce qui l'entoure. Aucun flou à calculer : `temp` est déjà diffusé par le moteur, donc l'air autour d'une flamme est chaud — le halo est un sous-produit de la thermique. |
| Heure | Menu « Heure » : matin (doré), après-midi, soir (orangé), nuit (bleu sombre), ou « Cycle », une journée en fondu toutes les 4 minutes. La teinte n'épargne que ce qui émet (feu, lave, braises, étincelles, uranium…) : la nuit, avec l'éclairage, ce sont eux qui font voir le bac. L'heure s'affiche en tête du bac, à côté des fps : 6h, 15h, 20h, 2h, ou qui tourne avec le cycle. Propre à chaque écran, le salon ne la partage pas. |
| Vitesse | Curseur ×0,25 à ×4 : nombre de ticks de simulation par frame, avec reliquat pour le ralenti et plafond à 8 ticks pour ne pas s'enliser. |
| Vent & gravité | Un curseur biaise la dérive horizontale, la touche `g` retourne la gravité. |
| Température ambiante | Un curseur de -40 à 90 °C : c'est la température vers laquelle tout le bac retourne (`COOLING`). À -5 °C un lac gèle tout seul, à 90 °C plus rien ne prend. Le climat de la scène, en un réglage. |
| Ciment | Liquide qui prend en pierre à 60 °C : on le coule dans un moule et on le chauffe. Bâtir devient un geste de simulation, pas un coup de pinceau. Zéro ligne dans le moteur, juste un `boil`. |
| Aimant & limaille | Un clic sur un aimant posé inverse son pôle : il repousse au lieu d'attirer, et le parcours du disque s'inverse avec lui (attirer part du centre, repousser du bord — comme le souffle). La seule règle de déplacement qui **ignore la gravité** : l'aimant tire d'un cran vers lui toute limaille dans un rayon de 5, du centre vers le bord (l'inverse du souffle) pour que les grains proches se collent d'abord. Un chapelet d'aimants fait remonter un tas de limaille le long d'un mur. |
| Figer | L'outil « Figer » (touche `f`) immobilise la matière sous le pinceau : elle garde son identité et sa couleur (tramée en damier), mais aucune règle ne s'applique plus et rien ne peut la pousser. « Libérer » la rend à la gravité, repeindre par-dessus aussi. De quoi bâtir une structure en sable ou suspendre une cascade. |
| Annuler / rétablir | `Ctrl+Z` et `Ctrl+Y` (ou `Ctrl+Maj+Z`) : dix crans (moins en grande grille : 64 Mo de copies au plus, quatre crans en 1920×1080), chacun revenant à l'état d'avant un geste (coup de pinceau, remplissage, « Vider », chargement d'un monde ou d'un défi). Une copie des quatre tableaux de la grille, ~400 ko le cran en 320×180. Les deux piles se dépilent l'une dans l'autre — un même `jump()` sert aux deux sens — et un nouveau geste referme la branche annulée. |
| Sonde | La barre du haut affiche la matière et la température sous le curseur : sans elle, la vue thermique n'est qu'un dégradé. S'y ajoutent le nombre de cellules pleines et les images par seconde réellement posées — celles que livre le Worker de simulation, pas le rythme de l'écran. |
| Symétrie | Une case à cocher : chaque coup de pinceau est aussi peint en miroir horizontal. Les moules, arches et cuvettes se font d'une main. |
| Chrono des défis | Le temps de la réussite s'affiche et le meilleur reste dans `localStorage`, par défi. Horloge murale : la pause compte, c'est un chrono de joueur, pas de simulation. Vider le bac, changer sa taille, charger un monde ou tirer une surprise abandonne le défi en cours : un Débâcle vidé n'a plus de glace, il était gagné d'avance. |
| Figé sauvegardé | La sérialisation porte deux blocs séparés par un point : la matière, puis le figé quand il y en a. Un monde partagé garde donc ses structures suspendues, et un monde d'avant (sans point) reste lisible. |
| État sauvegardé | La sérialisation porte jusqu'à cinq blocs : matière, figé, `life`, la température ramenée à un octet par pas de 8 °C, puis les noms donnés aux héros. Un incendie enregistré repart chaud, une mèche allumée reste allumée. Coût : ~20 caractères sur une scène au repos, ~1,8 ko en plein feu. Les mondes d'avant, à un ou deux blocs, se relisent tels quels. |
| Lien court | Le RLE est en base64 **url** (`-`, `_`, sans `=`) : les trois seuls caractères qu'`encodeURIComponent` échappe à trois caractères pièce. Et une longueur de 0 sert d'échappe vers un compte sur 16 bits, sinon un ciel vide coûtait une paire tous les 255 pixels. La scène de départ tient en ~520 caractères d'URL, état vivant compris. |
| Aperçu du pinceau | Un cercle à la taille réelle suit le curseur — un `<div>` posé au-dessus du bac, en pixels d'écran : rien dans le rendu, et il suit le zoom sans le savoir. |
| Matières récentes | Les six dernières choisies, épinglées au-dessus des familles. La palette étant un accordéon exclusif, y revenir coûtait sinon deux clics. |
| Météo | Sec, pluie, orage ou gros orage : il pleut du haut du bac, et c'est de la neige si l'ambiante est sous zéro. L'orage ne pleut pas plus fort (le bac se noierait et ralentirait) : il lance un éclair toutes les cinq secondes environ, le gros orage un par seconde, à vitesse ×1 — l'éclair suit la simulation, pas l'horloge. L'éclair zigzague en feu à travers l'air et les gouttes jusqu'à la première matière : le métal reçoit une étincelle qui court dans le circuit, le reste prend une gerbe de feu (le bois brûle, le TNT saute). Une cellule figée n'est pas frappée. La gravité inversée fait tomber la pluie — et l'éclair — du bas. |
| Surprise | Un décor tiré au sort parmi quatre (volcan, banquise, chantier, atelier) : même mécanique que les défis, sans objectif. |
| Nouveau monde | Un monde généré à la taille du bac : collines, lacs, arbres et lapins en surface ; grottes sèches ou noyées, poches de pétrole, veines de métal, grains d'uranium et lave en profondeur. Une graine (1 à 999 999) le décrit tout entier : champ vide, un monde au hasard dont la barre de statut donne le numéro ; même graine, même monde, à toute taille. Il naît au repos — sable seulement sur les pentes douces, eau à niveau, pétrole et lave enfermés — et s'endort presque entièrement : en 1920×1080, moins de 2 ms par tick. |
| Rectangle | Outil « Rectangle » : le glissé remplit un rectangle de la matière choisie, symétrie et « ne pas écraser » compris. Le pinceau à main levée ne trace pas un mur droit, et il en faut un pour bâtir un réservoir ou un moule. Même marquee que « Copier », et comme lui il ne s'applique qu'au relâchement. |
| Raccourcis | Une douzaine de touches et de clics, listés une seule fois dans l'onglet Raccourcis de la fenêtre Paramètres (bouton ⚙, ou la touche `?` qui ouvre directement cet onglet). Il est rangé en encadrés, comme le panneau (Matière, Pinceau, Simulation, Physique du monde, Défis, Mondes, Héros et vue), qu'un menu d'onglets ouvre un à un ; chacun liste ses touches et ses gestes de souris. Toutes les touches du clavier s'y réassignent, combinaisons avec Ctrl comprises : cliquer la touche, presser la nouvelle (Échap annule) ; une touche déjà prise s'échange, elles sont gardées d'une visite à l'autre, et les flèches marchent toujours. Les gestes de souris restent fixes. La liste du clavier est remplie depuis les touches choisies et `SHORTCUTS` : ni une touche changée ni une barre réordonnée ne laissent une aide qui ment. |
| Copier / coller | Outil « Copier » : le glissé découpe un rectangle, `Ctrl+V` le repose centré sous le curseur. `life` part avec le morceau — sans lui un interrupteur collé perdrait son état et une source la matière qu'elle crache. |
| Pipette | `Alt` + clic sur le bac reprend la matière sous le curseur : plus court que de rouvrir la famille dans la palette. |
| Vidéo | `canvas.captureStream()` + `MediaRecorder`, deux API natives : le bac se filme en `.webm`. C'est la copie agrandie ×4 qui est filmée (celle du PNG), pas le canvas de 320 pixels de large. |
| Rejeu | « Enregistrer » puis « Rejouer » : rien n'est filmé. On garde la grille de départ, l'état du tirage au sort (`engine.seed`), le sens du balayage et la liste des gestes horodatés en ticks — le moteur ne tire qu'au xorshift semé, donc les rejouer redonne la même partie au pixel près. Quelques kilo-octets là où la vidéo pèse des mégaoctets, et un rejeu se rejoue *dans* la simulation : on peut le regarder à une autre vitesse. C'est aussi ce qui sert de test de non-régression au moteur (test/sim.ts). « Lien du rejeu » le copie dans un lien (compressé, quelques kilo-octets), « Fichier du rejeu » le télécharge en `.json`, « Ouvrir un rejeu » le relit : il se joue aussitôt, le bac prend sa taille. Un rejeu venu d'ailleurs est vérifié champ par champ avant de toucher au bac. La pause arrête le rejeu et « Pas à pas » l'avance d'un tick ; vider, annuler, charger un monde ou bâtir une scène l'interrompt, et à la fin le bac reprend les réglages du panneau (gravité, vent, ambiante). |
| Zoom & déplacement | Molette (ou pincement à deux doigts, ou `+` / `-`) pour zoomer autour du curseur, clic du milieu ou ZQSD / WASD / flèches tenues pour déplacer — la caméra d'un grand monde. La vue est bornée : le bac agrandi recouvre toujours son cadre. Une transformation CSS sur le canvas : `toCell()` passe par `getBoundingClientRect()`, qui en tient déjà compte — le pinceau suit sans une ligne de correction. |
| Taille de grille | 320×180, 480×270, 640×360, 1280×720 ou 1920×1080, tous en 16/9 — les deux dernières tiennent grâce aux blocs de veille. Quand trop de matière bouge à la fois (un lac entier qui s'étale en 1920×1080), le bac ralentit au lieu de ramer : une frame ne s'accorde que 12 ms de simulation et oublie le reste de son retard, le pinceau et l'affichage restent fluides. `Engine` et `Renderer` sont recréés, les réglages du monde reportés. Les défis, écrits en dur pour 320×180, y ramènent d'eux-mêmes. |
| Ménage nocturne | Un Cron Trigger (4 h du matin) ne garde que les mondes que la galerie montre : les 50 plus récents et les 50 plus vus. Une rafale de sauvegardes ne chasse donc pas un monde que les joueurs chargent. |
| Défis partagés | Un monde sauvegardé avec un objectif (« au moins / moins de N cellules de X ») devient un défi jouable depuis la galerie, marqué 🎯. L'objectif tient en une chaîne `ge:12:600` validée côté Worker ; deux comparaisons suffisent — « plus aucun X » s'écrit « moins de 1 ». Aucun code à écrire pour ajouter un défi de plus. |
| Bac partagé | Un salon = un Durable Object qui **relaie et ne simule pas**, en **lockstep** : chacun simule chez soi, à 60 images par seconde. Le moteur est déterministe (un seul tirage au sort, semé) : il suffit que tous partent de la même grille et appliquent les mêmes gestes aux mêmes ticks. Le premier connecté est l'hôte et mène la partie : il envoie un départ (la grille entière, ~2 à 9 Ko) quand quelqu'un arrive, puis vingt fois par seconde la suite — les gestes, les réglages changés et le tick atteint, une cinquantaine d'octets. C'est le rejeu, en direct. Les invités lui envoient leurs coups de pinceau et rejouent la partie un peu derrière lui ; une empreinte de la grille par seconde attrape une divergence, et l'invité redemande alors un départ. Si l'hôte s'en va, le plus ancien restant prend la main, sans que le bac saute. Huit places par salon, messages plafonnés à la taille d'un monde, et le salon ne relaie que ce que chacun a le droit de dire : un invité ne peut ni destituer l'hôte, ni imposer sa grille aux autres. Pause, Pas à pas, vider, annuler et charger restent à l'hôte. Une connexion qui tombe est retentée une fois, une seconde plus tard, sans retaper le nom du salon. |
| Galerie triée | Un `<select>` bascule entre « plus récents » et « plus vus ». Le tri se fait sur la liste déjà en main (plafonnée à 100 mondes), pas d'aller-retour au Worker. Charger un monde passe par `GET /api/worlds/:id`, seul endroit qui incrémente `views`, sous limite de débit : une boucle de chargements ne hisse pas un monde en tête. |
| Accessibilité | Les flèches parcourent les grilles de matières (sinon quarante-sept tabulations), la barre de statut et le but des défis sont des `role="status"` — les changements sont annoncés au lecteur d'écran. |
| En-têtes | Le Worker pose une CSP stricte (aucun script ni style en ligne — la pastille de couleur d'une matière est montée en CSSOM exprès), `nosniff`, `referrer-policy`, et COOP / COEP — la page isolée, condition de la mémoire partagée du moteur multi-fils — sur toute réponse, et un `cache-control` d'un an sur les fichiers hashés contre `no-cache` sur le HTML. Vérifié dans test/api.ts avec un faux binding ASSETS. |
| Réglages retenus | Matière, pinceau, outil, vitesse, vent, ambiante, taille de grille, zoom et les cases du panneau (symétrie, ne pas remplacer, gomme sélective, vue thermique), la météo et l'heure sont relus dans `localStorage` au chargement suivant. |
| Bac repris | La scène est écrite dans `localStorage` quand l'onglet passe en arrière-plan (`visibilitychange`, le seul événement fiable sur mobile) et rechargée au retour. Un lien partagé passe devant, la cuvette de départ n'arrive qu'à défaut. L'état vivant part avec la grille : un incendie laissé en plan repart chaud. La largeur de la grille est rangée avec elle, comme dans un lien : un défi joué en 320 revient en 320, même si le réglage de taille disait 480. |
| Plusieurs cœurs | Le moteur se fait aider par des fils auxiliaires (autant que de cœurs moins deux, sept au plus) qui partagent sa mémoire : la grille est découpée en damier de blocs 32×32, traités en quatre phases où deux blocs voisins ne tournent jamais ensemble, chacun avec son propre tirage au sort. Le résultat ne dépend pas du nombre de fils — un salon entre une machine à huit cœurs et une à deux reste en phase, et une page sans mémoire partagée simule seule, à l'identique. En 1920×1080 chargé : 25,7 ms par tick sur un fil, 7,6 sur quatre, 5,6 sur huit. Les explosions, qui portent trop loin pour le damier, sont jouées juste après, une à une. |
| Blocs de veille | La grille est découpée en blocs de 16×16, et un bloc où rien ne bouge — lac étale, tas de sable posé, mur — n'est plus ni balayé ni chauffé. Toute écriture réveille son bloc et ses voisins ; une flamme, une plante ou un lapin gardent le leur éveillé. Un bac au repos en 1920×1080 passe de 30 ms à moins d'une milliseconde par tick — une mer de lave comprise, une fois posée (elle restait éveillée et coûtait 180 ms par tick). L'affichage suit les mêmes blocs : seuls les blocs changés partent vers la page, en bandes de données dont les tampons sont transférés sans copie, et seule leur zone est recoloriée. |
| Simulation à part | Le moteur tourne dans un Web Worker : il n'envoie à la page que les données des blocs changés (matière, état, température au degré), et c'est la carte graphique de la page qui les colorie : un shader WebGL2, un envoi à l'écran par rafraîchissement, limité au rectangle changé. Sans WebGL2, le même coloriage en JavaScript prend le relais. Une explosion en 640×360 ne fige plus le panneau, le zoom ni le pinceau. La page envoie des ordres, le Worker renvoie des nouvelles (`sim/sandbox.ts`), et un onglet en arrière-plan ralentit la simulation au lieu de la faire rattraper d'un coup. |
| Jour / nuit | Dans la fenêtre Paramètres (bouton ⚙ de la barre du panneau), thème Système / Jour / Nuit : un seul `color-scheme` sur la page, le CSS n'emploie que `light-dark()` et les contrôles natifs suivent. En « Système », c'est le réglage du système qui décide, et la page le suit s'il change. |
| Page | Pas de bandeau : le nom du site s'affiche à l'arrivée, sur une ligne, par-dessus la page floutée, puis s'efface avec le flou en moins de trois secondes (animation CSS, fondu seul si le système réduit les animations). Images par seconde, cellules pleines et sonde sont dans un encadré au-dessus du bac, à hauteur de la barre Pause / Pas à pas. |
| Plein écran | Bouton « Plein écran » : `requestFullscreen()` sur le canvas, le CSS `pixelated` fait la mise à l'échelle et le rendu ne change pas d'une ligne. |
| Image PNG | Le bac est réexporté ×4 sans lissage (`imageSmoothingEnabled = false`) et téléchargé : un PNG net, pas une capture d'écran floue. |
| Ligne & remplissage | `Maj` + clic trace une ligne droite depuis le dernier point posé, clic droit remplit toute la poche de matière identique sous le curseur. |
| Défis | Sept scènes prêtes à jouer (Débâcle, Mèche lente, Court-circuit, Puits, Désamorçage, Coup de grisou, Jardin) avec leur objectif et sa détection de victoire, construites en code dans `challenges.ts`. Un défi se bâtit toujours à 20 °C, quelle que soit l'ambiante réglée : baissée avant de lancer « Grand froid », elle bâtissait le lac déjà gelé. |
| Familles | La barre d'outils est découpée en `<details>` repliables (`CATEGORIES` dans `materials.ts`) : une famille ouverte à la fois suffit à tenir dans le panneau. Les raccourcis 1..9 / 0 restent sur les dix classiques, indépendamment de l'ordre d'affichage. |
| Pinceau | Rayon de 1 à 64 cellules (`[` et `]`) : 64 pour qu'un geste compte encore en 1920×1080. Case « Ne pas remplacer » : on ne peint que le vide, la matière déjà posée est préservée (la gomme efface toujours), case « Gomme sélective » : la gomme ne retire que la dernière matière choisie. Clic maintenu = dépôt continu, même sans bouger la souris. Une créature (le lapin) fait exception : un clic en pose une, sans trait ni dépôt continu, et le cercle d'aperçu prend sa taille. |
| Lien | Le bouton « Lien » met le monde entier dans l'URL (RLE + base64, ~1 ko) et le copie. La largeur de la grille passe devant (`#320~…`) : le bac du visiteur s'y met, sinon un monde 480 relu dans un bac 320 se décale d'une ligne à chaque rangée. |
| Galerie | « Sauvegarder » envoie le monde au Worker, « Galerie » ouvre une modale (`<dialog>` natif) qui liste tous les mondes sauvegardés avec leur vignette : la grille décodée est redessinée dans un canvas hors écran, mêmes couleurs que le bac. Un clic charge la scène ; un monde supprimé entre-temps le dit dans sa vignette, et un serveur injoignable charge la copie de la liste, sans état vivant, en le signalant. La croix au survol d'une vignette supprime le monde, mais seulement sur ceux qu'on a soi-même sauvegardés : le Worker rend un jeton de suppression à la sauvegarde, le navigateur le garde dans `localStorage` et le présente au `DELETE`. Une seule requête : la liste renvoie les grilles coupées à leur bloc matière, quelques centaines d'octets chacune. Un monde trop lourd pour l'API (200 000 caractères : un grand bac en feu) est sauvegardé sans son état vivant — matière et figé seulement — et la barre de statut le dit. Elle dit aussi pourquoi une sauvegarde ou une suppression échoue : serveur injoignable, ou trop de requêtes (attendre une minute). |

## Stack

| Morceau | Choix | Pourquoi |
| --- | --- | --- |
| Front | TypeScript + Vite, WebGL2 (canvas 2D en secours), aucun framework | 1 cellule = 1 pixel : la grille monte en textures, un shader la colorie, un seul dessin par frame. Budgets de bundle en CI : 80 Kio pour la page (JS + CSS), 80 Kio pour le moteur (Worker). |
| Simulation | Web Worker | Le moteur ne partage pas le fil de la page. Coût du tick : `npm run bench`, la CI échoue au-delà de 4 ms en 320×180. |
| Serveur | Worker Cloudflare + [Hono](https://hono.dev) | Un seul déploiement sert le site statique **et** l'API (`env.ASSETS`). |
| Stockage | D1 en déployé, Map en mémoire en local, même interface | Voir `src/worker/store.ts`. |
| Temps réel | Durable Object + WebSocket (hibernation) | Un salon = un DO qui relaie sans simuler ; chaque client simule en lockstep. Voir `src/worker/room.ts`. |

### Pages ou Workers ?

Les deux ne sont plus séparés : un Worker avec la clé `assets` sert les fichiers
statiques *et* le code serveur. C'est ce que Cloudflare recommande pour les
nouveaux projets, et ça évite d'avoir un projet Pages + un Worker à synchroniser.

### Et Rust ?

Rust sur Cloudflare passe par WebAssembly. Deux usages possibles :

1. **Le Worker en Rust** (`workers-rs`) — déconseillé ici : DX plus lourde,
   bindings D1/AI moins confortables, et le Worker ne fait que du routage JSON.
2. **Le noyau de simulation en Rust → WASM** — c'est là que ça devient
   intéressant : la boucle de `engine.ts` est un automate cellulaire sur des
   tableaux d'octets, exactement ce que WASM fait bien. `Engine` a été écrit avec
   cette frontière en tête : `cells` / `life` / `noise` sont des tableaux plats,
   le rendu ne fait que lire `cells`. Le jour où la grille passe à 1000×600 ou
   où plusieurs milliers d'agents bougent, on remplace l'intérieur de `Engine`
   par un module `wasm-bindgen` en gardant la même interface (`step`, `paint`,
   `cells`).

   Premier essai mesuré : `thermal()` porté en Rust dans [rust/](rust/)
   (`npm run rust`). En SIMD, il est deux fois plus rapide que JavaScript, au
   bit près. Mais la chaleur ne pèse que 10 à 20 % du tick en 1920×1080 : ce
   sont les règles des cellules qu'il faudrait porter pour que ça se sente.
   Détails et installation de Rust dans [docs/rust.md](docs/rust.md).

## Commandes

```bash
npm install        # Node ≥ 24 (exécution native du TypeScript)
npm run dev        # http://localhost:5173 — front + Worker dans workerd, avec HMR, store en mémoire
npm run typecheck  # client, worker et tests ont chacun leur tsconfig (DOM, runtime Workers, Node)
npm run check      # auto-vérifications : simulation, panneau, API, protocole du bac, moteur multi-fils (test/*.ts, Node exécute le TS tel quel)
npm run browser    # dans Chromium : shader WebGL2 = rendu JS, page qui charge (npx playwright install chromium la première fois)
npm run bench      # coût du tick sur cinq tailles de grille ; échoue au-delà de 4 ms en 320×180
npm run directions # que rapporteraient plusieurs cœurs ? (la carte graphique : test/gpu.html sous npm run dev)
npm run rust       # que rapporterait Rust ? thermal() en Rust/WASM contre le moteur JS (installer Rust : docs/rust.md)
npm run loc        # taille du projet par poste
npm run build      # typecheck puis vite build
npm run preview    # build puis exécution du Worker en local
npm run cf-typegen # régénère worker-configuration.d.ts après un changement de bindings
npm run deploy     # build, check puis wrangler deploy (npx wrangler login la première fois)
```

## API

| Route | Effet |
| --- | --- |
| `GET /api/health` | État + backend de stockage actif |
| `GET /api/worlds` | Liste des 50 mondes les plus récents et des 50 plus vus, grille coupée à son bloc matière (de quoi faire les vignettes) |
| `GET /api/worlds/:id` | Un monde complet ; compte une vue (dans la limite du débit) |
| `POST /api/worlds` | Sauvegarde `{ name, width, height, data, goal? }`, répond `201 { id, token }` |
| `DELETE /api/worlds/:id` | Supprime un monde, avec l'en-tête `x-world-token` reçu à la sauvegarde (`403` sinon) |
| `GET /api/room/:id` | Ouvre une WebSocket vers le salon partagé `:id` |
| `POST /api/error` | Rapport d'erreur d'un joueur (texte, 16 Kio max), écrit dans les journaux du Worker ; répond `204` |

Le jeton de suppression est tiré par le Worker et rendu **une seule fois**, par le `POST` : aucune route de lecture ne le renvoie. Les mondes d'avant les jetons ne se suppriment plus que par le ménage nocturne.

Les deux routes d'écriture et l'ouverture d'un salon passent par le binding **Rate Limiting** de Cloudflare (`unsafe` dans `wrangler.jsonc`) : 20 requêtes par IP et par minute, `429` au-delà, aucun compteur à stocker. En dev local le binding est absent et tout passe.

`data` est la grille en RLE + base64 url (`src/client/sim/codec.ts`), état
vivant compris : un monde 320×180 pèse de quelques centaines d'octets au repos
à un ou deux kilo-octets en plein feu. Plafond : 200 000 caractères.

## Base de données (D1)

D1 est branché : le binding `DB` est déclaré dans `wrangler.jsonc`, et
`createStore()` l'utilise dès qu'il existe. `npm run dev` et `npm run preview`
ont le leur, un D1 local (`.wrangler/`) : y appliquer aussi les migrations,
avec `--local`. Les tests (`test/api.ts`) n'ont pas de binding : c'est une
`Map` en mémoire qui répond, sans rien partager.

Le schéma évolue par fichiers numérotés dans `migrations/` — un nouveau fichier
par changement, jamais de retouche d'un ancien :

```bash
npx wrangler d1 migrations apply sandbox-rabbit --remote   # après chaque nouvelle migration
```

Pour repartir d'une base neuve (autre compte Cloudflare) : `npx wrangler d1
create sandbox-rabbit`, reporter le `database_id` dans `wrangler.jsonc`, appliquer
les migrations, puis `npm run cf-typegen`.

## Pistes

**Comportements IA**

Deux pistes distinctes, à ne pas confondre :

- *Comportements dans la simulation* — le lapin en est la première forme : des
  règles fixes dans `engine.ts`, sans appel réseau. Prochaine étape, l'évolution :
  quelques gènes par lapin (vitesse, tolérance à la chaleur…) hérités avec
  mutation, pour que la sélection trouve la stratégie à la place de la règle.
  Il faudra un tableau de plus, donc un bloc de plus en fin de codec.
- *IA générative côté Worker* — ajouter `"ai": { "binding": "AI" }` dans
  `wrangler.jsonc` donne accès à Workers AI depuis le Worker : générer une
  carte à partir d'une description, commenter ce que fait le joueur, etc.
  Il faudrait alors déclarer le binding (optionnel, `AI?: Ai`) dans l'interface
  `Env` de `src/worker/app.ts`.

**Social et contenu**

- *Rejeu exportable* — fait : en lien ou en fichier (voir « Rejeu » plus
  haut).
- *Classement vérifié des défis* — écarté : le serveur rejouerait chaque
  partie pour constater lui-même la victoire, mais c'est ~0,5 ms par tick en
  320×180 sous workerd, ~9 s de calcul pour 5 min de partie. L'offre gratuite
  des Workers accorde 10 ms par requête : il faudrait l'offre payante. Un
  classement qui croirait le temps annoncé se tricherait d'une requête.

**Dette connue** : les `ponytail:` du code (perte de contexte WebGL, gravité
inversée du lapin, éclairage absent du rendu de secours, salon sans identité ni
prédiction locale, records locaux, héros sans métier ni inventaire, onde de pression sans inertie qui traverse les murs, piles
d'erreur minifiées…). La skill `ponytail-debt` en fait la liste
complète ; ailleurs, `grep -rn -A6 --exclude-dir=target "ponytail:" src test rust migrations .github index.html wrangler.jsonc`.

## Contribuer

Les consignes de développement — architecture, invariants du moteur, recettes
(ajouter une matière, un défi, une route…), tests et budgets de la CI — sont
dans [AGENTS.md](AGENTS.md) et [docs/agents/](docs/agents/). Elles servent aux
agents IA comme aux humains.

**Nouvelle matière**, en bref : une entrée dans `MATERIALS` + son id dans une
famille de `CATEGORIES`. Si son comportement n'est pas couvert par `kind`
(`powder` / `liquid` / `gas` / `static`), lui ajouter un `case` dans
`Engine.update`. La marche complète est dans
[docs/agents/recettes.md](docs/agents/recettes.md).

## Licence

[MIT](LICENSE) : réutilisation, modification et redistribution libres, à
condition de garder la mention de copyright.
