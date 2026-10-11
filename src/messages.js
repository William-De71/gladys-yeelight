// -----------------------------------------------------------------------------
// Every message this integration shows to the user, in the four languages of
// Gladys (en, fr, de, es).
//
// Gathered here rather than inline in `index.js`: a message added in English
// only would show up in English in a German interface, and keeping them side by
// side is what makes a missing translation visible in review. The messages test
// checks that every entry carries the four languages.
//
// The connection status and the action results take a `{ en, fr, de, es }`
// object; Gladys picks the user's language and falls back to English.
// -----------------------------------------------------------------------------

/**
 * Messages without parameters. Values (error texts) are never translated: they
 * come from the bulb or the network as they are.
 */
export const MESSAGES = {
  noBulbFound: {
    en: 'No Yeelight bulb found. Check that "LAN Control" is enabled in the Yeelight app.',
    fr: "Aucune ampoule Yeelight trouvée. Vérifiez que « Contrôle LAN » est activé dans l'application Yeelight.",
    de: 'Keine Yeelight-Lampe gefunden. Prüfen Sie, ob „LAN-Steuerung“ in der Yeelight-App aktiviert ist.',
    es: 'No se ha encontrado ninguna bombilla Yeelight. Compruebe que «Control LAN» está activado en la aplicación Yeelight.',
  },
  initFailed: {
    en: 'Initialization failed, check the integration logs.',
    fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
    de: 'Die Initialisierung ist fehlgeschlagen, prüfen Sie die Protokolle der Integration.',
    es: 'La inicialización ha fallado, consulte los registros de la integración.',
  },
  testNoAnswer: {
    en: 'No Yeelight bulb answered. Check that they are powered on and that "LAN Control" is enabled in the Yeelight app.',
    fr: "Aucune ampoule Yeelight n'a répondu. Vérifiez qu'elles sont allumées et que « Contrôle LAN » est activé dans l'application Yeelight.",
    de: 'Keine Yeelight-Lampe hat geantwortet. Prüfen Sie, ob sie eingeschaltet sind und „LAN-Steuerung“ in der Yeelight-App aktiviert ist.',
    es: 'Ninguna bombilla Yeelight ha respondido. Compruebe que están encendidas y que «Control LAN» está activado en la aplicación Yeelight.',
  },
};

/**
 * Result of a successful connection test.
 * @param {number} bulbCount - How many bulbs answered.
 * @param {number} featureCount - How many features they expose in total.
 * @returns {object} The message, in the four languages.
 * @example
 * testOk(2, 7);
 */
export function testOk(bulbCount, featureCount) {
  return {
    en: `Connection OK: ${bulbCount} bulb(s), ${featureCount} feature(s) available.`,
    fr: `Connexion OK : ${bulbCount} ampoule(s), ${featureCount} fonctionnalité(s) disponible(s).`,
    de: `Verbindung OK: ${bulbCount} Lampe(n), ${featureCount} Funktion(en) verfügbar.`,
    es: `Conexión correcta: ${bulbCount} bombilla(s), ${featureCount} función(es) disponible(s).`,
  };
}

/**
 * Result of a failed connection test.
 * @param {string} reason - The error message, shown as is.
 * @returns {object} The message, in the four languages.
 * @example
 * testFailed('timeout');
 */
export function testFailed(reason) {
  return {
    en: `Connection failed: ${reason}`,
    fr: `Échec de la connexion : ${reason}`,
    de: `Verbindung fehlgeschlagen: ${reason}`,
    es: `Error de conexión: ${reason}`,
  };
}

/**
 * Result of the "reconnect" action.
 * @param {number} bulbCount - How many bulbs are available again.
 * @returns {object} The message, in the four languages.
 * @example
 * reconnectOk(3);
 */
export function reconnectOk(bulbCount) {
  return {
    en: `Reconnected: ${bulbCount} bulb(s) available.`,
    fr: `Reconnexion effectuée : ${bulbCount} ampoule(s) disponible(s).`,
    de: `Neu verbunden: ${bulbCount} Lampe(n) verfügbar.`,
    es: `Reconexión realizada: ${bulbCount} bombilla(s) disponible(s).`,
  };
}

/**
 * Result of a failed "reconnect" action.
 * @param {string} reason - The error message, shown as is.
 * @returns {object} The message, in the four languages.
 * @example
 * reconnectFailed('timeout');
 */
export function reconnectFailed(reason) {
  return {
    en: `Reconnection failed: ${reason}`,
    fr: `Échec de la reconnexion : ${reason}`,
    de: `Neuverbindung fehlgeschlagen: ${reason}`,
    es: `Error de reconexión: ${reason}`,
  };
}
