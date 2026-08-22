// -----------------------------------------------------------------------------
// Yeelight LAN protocol constants and external-id scheme.
//
// Everything here comes from the official "Yeelight WiFi Light Inter-Operation
// Specification" (www.yeelight.com), not from guesswork: the discovery port,
// the header names, the value ranges and the per-connection quotas are all
// stated there, and several of them are unusual enough to be worth pinning.
//
// External ids follow the SDK convention (`gladys.externalIds(type, platformId)`
// prefixes them with `ext:<selector>:`). The platform id is the bulb ID the
// device reports in discovery (`id: 0x000000000015243f`), which is burned in at
// the factory — an IP address is a DHCP lease and never appears in an id.
//
//   device : ext:<selector>:yeelight:<bulbId>
//   feature: ext:<selector>:yeelight:<bulbId>:<featureKey>
// -----------------------------------------------------------------------------

// --- Discovery ---------------------------------------------------------------
// Yeelight deliberately does NOT use the standard SSDP port 1900: the spec
// explains they moved to 1982 to spare battery-powered devices the flood of
// generic multicast traffic. A standard SSDP scan therefore finds nothing, and
// the manifest must declare `udp-active-broadcast` on this port instead.
export const DISCOVERY_PORT = 1982;

// The multicast group the bulbs listen on. Written in the HOST header of the
// M-SEARCH; the core does the actual sending (see the discovery module).
export const DISCOVERY_MULTICAST_ADDRESS = '239.255.255.250';

// The ST value that makes a bulb answer. The spec is explicit: headers are
// case-insensitive but header VALUES are case-sensitive, and any message not
// matching the expected form is silently dropped — a discovery that finds
// nothing is the only symptom, so this string must stay exactly as-is.
export const DISCOVERY_ST = 'wifi_bulb';

// How long the core listens for the unicast replies to our M-SEARCH.
export const DISCOVERY_TIMEOUT_SECONDS = 5;

// --- Control -----------------------------------------------------------------
// Default TCP port of the control service. The real one is read from the
// `Location: yeelight://<ip>:<port>` header of the discovery reply; this is only
// the fallback for a bulb declared by hand.
export const DEFAULT_CONTROL_PORT = 55443;

// Every message — command, result and notification — is one line of JSON
// terminated by CRLF. This is the framing of the whole control protocol.
export const MESSAGE_TERMINATOR = '\r\n';

// Namespace of our device external ids (see the scheme above).
export const EXTERNAL_ID_TYPE = 'yeelight';

// --- Quotas (spec section 4) -------------------------------------------------
// A bulb accepts at most 4 simultaneous TCP connections and 60 commands per
// minute per connection. We hold ONE connection per bulb and rate-limit
// ourselves below that ceiling, because going over it does not fail loudly: the
// bulb simply stops answering, which reads like a broken light.
export const MAX_COMMANDS_PER_MINUTE = 55;

// Width of the sliding window the quota is counted over. Commands burst freely
// until the window is full and only then wait, so a scene setting several
// features at once still goes out inside the 5 s Gladys allows an `onSetValue`.
export const RATE_WINDOW_MS = 60000;

// How long to wait for the RESULT message that echoes our command id.
export const COMMAND_TIMEOUT_MS = 5000;

// TCP connect timeout, kept short: a bulb that is powered off must not hold a
// discovery pass for long.
export const CONNECT_TIMEOUT_MS = 5000;

// --- Reconnection ------------------------------------------------------------
// A bulb cut from power (wall switch) is the normal case, not an anomaly, so
// reconnection backs off instead of hammering the network.
export const RECONNECT_INITIAL_DELAY_MS = 5000;
export const RECONNECT_MAX_DELAY_MS = 300000;

// --- Value ranges (spec table 4-2) -------------------------------------------
// Brightness is a PERCENTAGE and its minimum is 1, not 0: a bulb has no "0%"
// state, `off` is carried by the power property instead. Sending 0 is refused.
export const BRIGHTNESS_MIN = 1;
export const BRIGHTNESS_MAX = 100;

// Color temperature in Kelvin. The usable range depends on the model, so these
// are only the fallback bounds of the spec; a bulb whose model is known gets
// the range of its model (see models.js).
//
// NOTE: these are the bounds of the YEELIGHT side of the wire. Gladys does not
// speak Kelvin for a `light.temperature` feature — it speaks MIRED (see the
// conversion in convert.js), so these values are converted before they ever
// reach a feature descriptor.
export const COLOR_TEMPERATURE_MIN = 1700;
export const COLOR_TEMPERATURE_MAX = 6500;

// Gladys stores a color as a single integer 0xRRGGBB, and so does Yeelight.
export const RGB_MIN = 1;
export const RGB_MAX = 16777215;

// --- Effects -----------------------------------------------------------------
// "smooth" fades over `duration` ms, "sudden" jumps and ignores the duration.
export const EFFECT_SMOOTH = 'smooth';
export const EFFECT_SUDDEN = 'sudden';

// The spec sets the floor at 30 ms for a smooth transition.
export const MIN_TRANSITION_MS = 30;

// --- Device params -----------------------------------------------------------
// Last known address, kept as a param so a reconnection does not need a fresh
// network scan. Not part of the external id: a DHCP lease changes, the id does
// not.
export const PARAM_ADDRESS = 'ADDRESS';
export const PARAM_MODEL = 'MODEL';
export const PARAM_FIRMWARE = 'FIRMWARE_VERSION';
export const PARAM_SUPPORT = 'SUPPORTED_METHODS';
