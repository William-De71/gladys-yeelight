# Yeelight integration

This integration lets you control your **Yeelight** lights (bulbs, LED strips, bedside lamps, ceiling lights) from Gladys Assistant, directly on your local network. No cloud account, no gateway, no middleman: Gladys talks to your lights itself.

## Features

The integration adapts to what each light can do — a light advertises its own capabilities, and only the features actually available are created:

| Feature                 | Lights concerned                               |
| ----------------------- | ---------------------------------------------- |
| On / off                | All                                            |
| Brightness (1 to 100 %) | All dimmable lights                            |
| Color (RGB)             | Color models (`color`, strips, bedside lamps)  |
| Color temperature       | Tunable-white and color models                 |
| Ambient light           | Ceiling lights and light bars with a backlight |
| Night light (moonlight) | Ceiling lights                                 |

### States arrive in real time

Your lights **push** their state changes: the integration keeps a connection open to each light, and Gladys receives the new value the moment it changes — including when you use the Yeelight app, the remote, or the wall switch. There is no polling interval to set.

## Requirements

### Enable "LAN Control" — mandatory

This is **the step not to skip**: by default a Yeelight light refuses every local command. Without this option the light is neither discoverable nor controllable.

For each light, in the **Yeelight** app:

1. Open the light.
2. Go to **Settings** (icon in the top right corner).
3. Enable **LAN Control** (also called "Developer mode").

> Do this for every light, one by one. It is a setting stored in the light itself.

### Network

- Gladys and your lights must be on the **same local network**.
- Discovery uses multicast (UDP port 1982). If your router filters it, or if your lights sit on another VLAN, you can still add them by hand (see below).

## Configuration

### 1. Discover your lights

Once "LAN Control" is enabled, open the integration's **Discover** screen and run a scan. Your lights appear with their name (the one you gave them in the Yeelight app), ready to be added. **No IP address to type.**

### 2. Transition duration

Sets the fade applied to every change (switching on, dimming, color). The default of **500 ms** gives a smooth, natural transition. Set **0** for an instant change.

### 3. Lights not found by the scan

If a light does not show up even though "LAN Control" is enabled, add its address under **Lights added by hand**, one per line:

```
192.168.1.42
192.168.1.43:55443
```

> **Important:** give those lights a **fixed IP address** in your router. Unlike a light found by the scan — identified by its serial number, stable for life — a light added by hand is identified by its address. If its DHCP lease changes, Gladys will see it as a different light.

### 4. Discovery duration

How long the scan listens for answers. 5 seconds is plenty in most cases; raise it if your network is busy and some lights are missing.

## Available actions

- **Test the connection**: runs a discovery and reports how many lights answered.
- **Reconnect the lights**: closes every connection and reopens them. Useful after a power cut or a network change.

## Good to know

### Setting a color on a light that is off

A Yeelight refuses color, temperature and brightness commands while it is off. The integration **turns it on automatically** before applying your setting: clicking a color therefore switches the light on in that color, which is what you meant.

### Brightness starts at 1 %, not 0 %

A Yeelight has no "0 %" state: zero means off. Setting the brightness to 0 in Gladys therefore **switches the light off**.

### The color shown in white mode

When a light is in white mode (color temperature), it still remembers the last color used. Gladys deliberately does not show it as the active color, so you never see a color the light is not actually displaying.

### Light limits

Each light accepts **4 simultaneous connections** and **60 commands per minute**. The integration opens a single connection per light and smooths command bursts automatically, but keep those limits in mind if you also drive your lights from other apps at the same time.

## Troubleshooting

| Symptom                                | Most likely cause                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| No light found                         | "LAN Control" is not enabled in the Yeelight app                              |
| Only one light out of several is found | The option is only enabled on that one — it is set per light                  |
| A light disappears then comes back     | Wi-Fi drop or wall switch: the integration reconnects on its own, backing off |
| A hand-added light becomes unknown     | Its IP address changed — give it a fixed address in your router               |
| Commands stop working after a while    | Another piece of software is holding the light's 4 connection slots           |
