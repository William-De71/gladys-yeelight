# Intégration Yeelight

Cette intégration permet de piloter vos lampes **Yeelight** (ampoules, rubans LED, lampes de chevet, plafonniers) depuis Gladys Assistant, directement sur votre réseau local. Aucun compte cloud, aucune passerelle, aucun serveur intermédiaire : Gladys parle directement à vos lampes.

## Fonctionnalités

L'intégration s'adapte à ce que chaque lampe sait faire — une lampe annonce elle-même ses capacités, et seules les fonctionnalités réellement disponibles sont créées :

| Fonctionnalité         | Lampes concernées                                    |
| ---------------------- | ---------------------------------------------------- |
| Allumer / éteindre     | Toutes                                               |
| Luminosité (1 à 100 %) | Toutes les lampes réglables                          |
| Couleur (RVB)          | Modèles couleur (`color`, rubans, lampes de chevet)  |
| Température de couleur | Modèles blanc réglable et couleur                    |
| Lumière d'ambiance     | Plafonniers et barres lumineuses avec rétroéclairage |
| Veilleuse (mode lune)  | Plafonniers                                          |

### Les états arrivent en temps réel

Vos lampes **poussent** leurs changements d'état : l'intégration garde une connexion ouverte vers chaque lampe, et Gladys reçoit la nouvelle valeur à l'instant où elle change — y compris quand vous utilisez l'application Yeelight, la télécommande, ou l'interrupteur mural. Il n'y a pas d'intervalle d'interrogation à régler.

## Prérequis

### Activer « Contrôle LAN » — indispensable

C'est **l'étape à ne pas oublier** : par défaut, une lampe Yeelight refuse toutes les commandes locales. Sans cette option, la lampe ne sera ni trouvée ni pilotable.

Pour chaque lampe, dans l'application **Yeelight** :

1. Ouvrez la lampe.
2. Allez dans **Réglages** (icône en haut à droite).
3. Activez **Contrôle LAN** (« LAN Control » / « Mode développeur »).

> À refaire pour chaque lampe, une par une. C'est un réglage stocké dans la lampe elle-même.

### Réseau

- Gladys et vos lampes doivent être sur le **même sous-réseau** pour que la découverte automatique fonctionne.
- La découverte diffuse une requête en broadcast sur le port UDP 1982. **Un broadcast ne traverse jamais un routeur** : si vos lampes sont sur un autre VLAN ou un autre sous-réseau que Gladys, le scan ne les trouvera pas — c'est une limite du réseau, pas un réglage à ajuster. Allonger la durée du scan n'y change rien.
- Dans ce cas, ajoutez vos lampes **à la main** (voir plus bas) : le pilotage, lui, passe en TCP direct et fonctionne parfaitement entre sous-réseaux dès lors qu'ils sont routés.

## Configuration

### 1. Découvrir vos lampes

Une fois « Contrôle LAN » activé, allez dans l'écran **Découverte** de l'intégration et lancez un scan. Vos lampes apparaissent avec leur nom (celui que vous leur avez donné dans l'application Yeelight), prêtes à être ajoutées. **Aucune adresse IP à saisir.**

### 2. Durée de transition

Règle le fondu appliqué à chaque changement (allumage, variation, couleur). La valeur par défaut de **500 ms** donne une transition douce et naturelle. Mettez **0** pour un changement instantané.

### 3. Lampes non trouvées par le scan

Deux cas mènent ici, et le second est le plus courant :

- « Contrôle LAN » n'est pas activé sur la lampe (voir Prérequis) ;
- **vos lampes sont sur un autre sous-réseau / VLAN que Gladys** — le scan ne peut structurellement pas les atteindre, mais le pilotage fonctionne.

Ajoutez alors leur adresse dans **Lampes ajoutées à la main**, une par ligne :

```
192.168.1.42
192.168.1.43:55443
```

> **Important :** donnez à ces lampes une **adresse IP fixe** dans votre routeur. Contrairement à une lampe trouvée par le scan — identifiée par son numéro de série, stable à vie — une lampe ajoutée à la main est identifiée par son adresse. Si son bail DHCP change, Gladys la verra comme une nouvelle lampe différente.

### 4. Durée de la découverte

Temps pendant lequel le scan écoute les réponses. 5 secondes suffisent dans la grande majorité des cas ; augmentez cette valeur si votre réseau est chargé et que certaines lampes manquent à l'appel.

## Actions disponibles

- **Tester la connexion** : relance une découverte et indique combien de lampes ont répondu.
- **Reconnecter les lampes** : ferme toutes les connexions et les rouvre. Utile après une coupure de courant ou un changement de réseau.

## Bon à savoir

### Régler une couleur sur une lampe éteinte

Une lampe Yeelight refuse les commandes de couleur, de température et de luminosité quand elle est éteinte. L'intégration **l'allume automatiquement** avant d'appliquer votre réglage : cliquer sur une couleur allume donc la lampe dans cette couleur, ce qui est le comportement attendu.

### La luminosité commence à 1 %, pas à 0 %

Une Yeelight n'a pas d'état « 0 % » : le zéro, c'est l'extinction. Régler la luminosité sur 0 dans Gladys **éteint** donc la lampe.

### La couleur affichée en mode blanc

Quand une lampe est en mode blanc (température de couleur), elle continue de mémoriser la dernière couleur utilisée. Gladys ne l'affiche volontairement pas comme couleur active, pour ne pas montrer une couleur que la lampe n'a pas.

### Les plafonniers ont deux lumières indépendantes

Un plafonnier avec rétroéclairage (ceiling10, barres lumineuses…) expose **deux lumières séparées**, et Gladys les nomme explicitement :

- **Lumière principale**, **Luminosité principale**, **Couleur principale**, **Température de couleur principale** ;
- **Lumière d'ambiance**, **Luminosité d'ambiance**, **Couleur d'ambiance**.

Chacune s'allume et s'éteint indépendamment de l'autre. Pour piloter les deux d'un seul geste, créez une **scène** Gladys qui agit sur les deux interrupteurs : c'est la façon prévue par Gladys de grouper plusieurs commandes.

Sur une lampe sans rétroéclairage, il n'y a qu'une lumière et les libellés restent simples (**On/Off**, **Luminosité**, **Couleur**, **Température de couleur**).

### La température de couleur

Le curseur de température suit le dégradé de Gladys : **vers la gauche, une lumière froide et bleutée ; vers la droite, une lumière chaude et orangée.** L'intégration convertit automatiquement cette valeur vers les Kelvin que comprend la lampe, en respectant la plage réelle de votre modèle (2700–6500 K sur un plafonnier, 1700–6500 K sur une ampoule couleur).

### Limites des lampes

Chaque lampe accepte **4 connexions simultanées** et **60 commandes par minute**. L'intégration n'ouvre qu'une seule connexion par lampe et lisse automatiquement les rafales de commandes, mais gardez ces limites en tête si vous pilotez aussi vos lampes depuis d'autres applications en parallèle.

## En cas de problème

| Symptôme                                     | Cause la plus probable                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Aucune lampe trouvée                         | « Contrôle LAN » n'est pas activé dans l'application Yeelight                                   |
| Une seule lampe sur plusieurs est trouvée    | L'option n'est activée que sur cette lampe — elle se règle lampe par lampe                      |
| Une lampe disparaît puis revient             | Coupure Wi-Fi ou interrupteur mural : l'intégration se reconnecte seule, en espaçant les essais |
| Une lampe ajoutée à la main devient inconnue | Son adresse IP a changé — donnez-lui une adresse fixe dans votre routeur                        |
| Les commandes ne passent plus après un temps | Un autre logiciel occupe les 4 connexions de la lampe                                           |
