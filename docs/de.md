# Yeelight-Integration

Mit dieser Integration steuern Sie Ihre **Yeelight**-Lampen (Glühbirnen, LED-Streifen, Nachttischlampen, Deckenleuchten) aus Gladys Assistant heraus, direkt in Ihrem lokalen Netzwerk. Kein Cloud-Konto, kein Gateway, kein Zwischenserver: Gladys spricht selbst mit Ihren Lampen.

![Gladys, die Integration und Ihre Yeelight-Lampen: Die Lampen senden ihre Zustände über je eine offene Verbindung, die Befehle gehen von Gladys aus, und die Suche läuft über den Broadcast, den Gladys auf UDP-Port 1982 sendet](images/overview.svg)

## Funktionen

Die Integration passt sich an das an, was jede Lampe kann — eine Lampe meldet ihre Fähigkeiten selbst, und nur die tatsächlich verfügbaren Funktionen werden angelegt:

| Funktion                 | Betroffene Lampen                                     |
| ------------------------ | ----------------------------------------------------- |
| Ein / Aus                | Alle                                                  |
| Helligkeit (1 bis 100 %) | Alle dimmbaren Lampen                                 |
| Farbe (RGB)              | Farbmodelle (`color`, LED-Streifen, Nachttischlampen) |
| Farbtemperatur           | Modelle mit einstellbarem Weiß und Farbmodelle        |
| Ambientelicht            | Deckenleuchten und Lichtleisten mit Hintergrundlicht  |
| Nachtlicht (Mondlicht)   | Deckenleuchten                                        |

### Zustände kommen in Echtzeit an

Ihre Lampen **senden** ihre Zustandsänderungen von sich aus: Die Integration hält zu jeder Lampe eine Verbindung offen, und Gladys erhält den neuen Wert in dem Moment, in dem er sich ändert — auch wenn Sie die Yeelight-App, die Fernbedienung oder den Wandschalter benutzen. Es gibt kein Abfrageintervall einzustellen.

## Voraussetzungen

### „LAN-Steuerung“ aktivieren — unerlässlich

Das ist **der Schritt, den Sie nicht vergessen dürfen**: Standardmäßig lehnt eine Yeelight-Lampe jeden lokalen Befehl ab. Ohne diese Option wird die Lampe weder gefunden noch kann sie gesteuert werden.

Für jede Lampe, in der **Yeelight**-App:

1. Öffnen Sie die Lampe.
2. Gehen Sie in die **Einstellungen** (Symbol oben rechts).
3. Aktivieren Sie **LAN-Steuerung** („LAN Control“, auch „Entwicklermodus“ genannt).

> Für jede Lampe einzeln zu wiederholen. Die Einstellung wird in der Lampe selbst gespeichert.

### Netzwerk

- Gladys und Ihre Lampen müssen im **selben Subnetz** sein, damit die automatische Suche funktioniert.
- Die Suche sendet eine Anfrage als Broadcast auf UDP-Port 1982. **Ein Broadcast überquert niemals einen Router**: Liegen Ihre Lampen in einem anderen VLAN oder Subnetz als Gladys, findet die Suche sie nicht — das ist eine Grenze des Netzwerks, keine Einstellung. Eine längere Suchdauer ändert daran nichts.
- Fügen Sie Ihre Lampen in diesem Fall **manuell** hinzu (siehe unten): Die Steuerung selbst läuft direkt über TCP und funktioniert problemlos zwischen Subnetzen, sofern diese geroutet sind.

## Konfiguration

### 1. Ihre Lampen finden

Sobald „LAN-Steuerung“ aktiviert ist, öffnen Sie den Bildschirm **Entdecken** der Integration und starten Sie eine Suche. Ihre Lampen erscheinen mit ihrem Namen (dem, den Sie ihnen in der Yeelight-App gegeben haben) und können hinzugefügt werden. **Keine IP-Adresse einzugeben.**

![Zwei Quellen speisen den Bildschirm „Entdecken“: die Netzwerksuche, deren Antworten die Werks-ID, das Modell, die Fähigkeiten und den Zustand enthalten, und die manuell hinzugefügten Lampen, die über TCP abgefragt werden; beide ergeben ein Gerät pro Lampe](images/discovery.svg)

### 2. Übergangsdauer

Legt die Überblendung fest, die bei jeder Änderung angewendet wird (Einschalten, Dimmen, Farbe). Der Standardwert von **500 ms** ergibt einen sanften, natürlichen Übergang. Stellen Sie **0** für einen sofortigen Wechsel ein.

### 3. Von der Suche nicht gefundene Lampen

Zwei Fälle führen hierher, und der zweite ist der häufigste:

- „LAN-Steuerung“ ist auf der Lampe nicht aktiviert (siehe Voraussetzungen);
- **Ihre Lampen liegen in einem anderen Subnetz / VLAN als Gladys** — die Suche kann sie grundsätzlich nicht erreichen, die Steuerung aber funktioniert.

Tragen Sie dann ihre Adresse unter **Manuell hinzugefügte Lampen** ein, durch Kommas getrennt (der Port ist optional, standardmäßig 55443):

```
192.168.1.42, 192.168.1.43:55443
```

Eine IPv6-Adresse wird in eckige Klammern gesetzt: `[fe80::1]` oder `[fe80::1]:55443`. Eine Lampe, die hier eingetragen ist und zugleich von der Suche gefunden wird, erscheint nur einmal, unter der Identität, die ihr die Suche gibt.

> **Wichtig:** Geben Sie diesen Lampen eine **feste IP-Adresse** in Ihrem Router. Anders als eine von der Suche gefundene Lampe — erkannt an ihrer Seriennummer, die sich nie ändert — wird eine manuell hinzugefügte Lampe an ihrer Adresse erkannt. Ändert sich ihre DHCP-Zuweisung, hält Gladys sie für eine andere Lampe.

### 4. Suchdauer

Wie lange die Suche auf Antworten wartet. 5 Sekunden reichen in den allermeisten Fällen; erhöhen Sie den Wert, wenn Ihr Netzwerk stark ausgelastet ist und einige Lampen fehlen.

## Verfügbare Aktionen

- **Verbindung testen**: startet eine Suche und meldet, wie viele Lampen geantwortet haben.
- **Lampen neu verbinden**: schließt alle Verbindungen und öffnet sie neu. Nützlich nach einem Stromausfall oder einer Änderung im Netzwerk.

## Gut zu wissen

### Eine Farbe an einer ausgeschalteten Lampe einstellen

Eine Yeelight-Lampe lehnt Farb-, Temperatur- und Helligkeitsbefehle ab, solange sie ausgeschaltet ist. Die Integration **schaltet sie automatisch ein**, bevor Ihre Einstellung angewendet wird: Ein Klick auf eine Farbe schaltet die Lampe also in dieser Farbe ein — genau das, was Sie wollten.

![Wenn Sie an einer ausgeschalteten Lampe eine Farbe wählen, schaltet die Integration sie zuerst ein und sendet dann die Farbe; die Lampe meldet anschließend ihren neuen Zustand](images/commands.svg)

Der Einschaltzustand ist aus dem bekannt, was die Lampe bereits gemeldet hat: Eine Lampe, die schon leuchtet, wird nicht erneut eingeschaltet — das würde ihre Überblendung sichtbar neu starten.

### Die Helligkeit beginnt bei 1 %, nicht bei 0 %

Eine Yeelight-Lampe hat keinen Zustand „0 %“: Null bedeutet aus. Wenn Sie die Helligkeit in Gladys auf 0 stellen, **schaltet sich die Lampe also aus**.

### Die angezeigte Farbe im Weißmodus

Ist eine Lampe im Weißmodus (Farbtemperatur), merkt sie sich weiterhin die zuletzt verwendete Farbe. Gladys zeigt sie bewusst nicht als aktive Farbe an, damit Sie nie eine Farbe sehen, die die Lampe gar nicht zeigt.

### Deckenleuchten haben zwei unabhängige Lichter

Eine Deckenleuchte mit Hintergrundlicht (ceiling10, Lichtleisten…) stellt **zwei getrennte Lichter** bereit, und Gladys benennt sie ausdrücklich:

- **Main light**, **Main brightness**, **Main colour**, **Main colour temperature** (Hauptlicht);
- **Ambient light**, **Ambient brightness**, **Ambient colour**, **Ambient colour temperature** (Ambientelicht).

Jedes schaltet sich unabhängig vom anderen ein und aus. Um beide mit einer Geste zu steuern, legen Sie in Gladys eine **Szene** an, die auf beide Schalter wirkt — so gruppiert Gladys mehrere Befehle.

Die Farbtemperatur des Ambientelichts erscheint nur bei Modellen, deren Hintergrundlicht sein Weiß einstellen kann — der Warm/Kalt-Regler, den die Yeelight-App neben dem Farbrad des Rings anzeigt.

Bei einer Lampe ohne Hintergrundlicht gibt es nur ein Licht, und die Bezeichnungen bleiben einfach (**On/Off**, **Brightness**, **Colour**, **Colour temperature**). Sie können jede Funktion in Gladys umbenennen.

Wenn Ihre Deckenleuchte ihren Ring zusammen mit dem Hauptlicht ein- und ausschaltet, liegt das nicht an Gladys: Es ist die Option **„Automatisch ein/aus mit dem Hauptlicht“** der Yeelight-App. Deaktivieren Sie sie, um jedes Licht getrennt zu steuern.

### Die Farbtemperatur

Der Temperaturregler folgt dem Farbverlauf von Gladys: **links kaltes, bläuliches Licht; rechts warmes, orangefarbenes Licht.** Die Integration rechnet diesen Wert automatisch in die Kelvin um, die die Lampe versteht, und hält dabei den tatsächlichen Bereich Ihres Modells ein (2700–6500 K bei einer Deckenleuchte, 1700–6500 K bei einer Farbbirne).

### Grenzen der Lampen

Jede Lampe akzeptiert **4 gleichzeitige Verbindungen** und **60 Befehle pro Minute**. Die Integration öffnet nur eine Verbindung pro Lampe und glättet Befehlsschübe automatisch, aber behalten Sie diese Grenzen im Hinterkopf, wenn Sie Ihre Lampen gleichzeitig auch aus anderen Apps steuern.

## Fehlerbehebung

| Symptom                                        | Wahrscheinlichste Ursache                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| Keine Lampe gefunden                           | „LAN-Steuerung“ ist in der Yeelight-App nicht aktiviert                                 |
| Nur eine von mehreren Lampen wird gefunden     | Die Option ist nur auf dieser Lampe aktiviert — sie wird Lampe für Lampe eingestellt    |
| Eine Lampe verschwindet und kommt wieder       | WLAN-Abbruch oder Wandschalter: Die Integration verbindet sich selbst neu, in Abständen |
| Eine manuell hinzugefügte Lampe wird unbekannt | Ihre IP-Adresse hat sich geändert — geben Sie ihr eine feste Adresse in Ihrem Router    |
| Befehle kommen nach einer Weile nicht mehr an  | Eine andere Software belegt die 4 Verbindungen der Lampe                                |
| Eine manuell hinzugefügte Lampe wird ignoriert | Ihre Adresse hat sich geändert, oder die eckigen Klammern um eine IPv6-Adresse fehlen   |
