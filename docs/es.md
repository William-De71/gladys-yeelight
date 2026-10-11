# Integración Yeelight

Esta integración le permite controlar sus luces **Yeelight** (bombillas, tiras LED, lámparas de mesita, plafones) desde Gladys Assistant, directamente en su red local. Sin cuenta en la nube, sin pasarela, sin servidor intermedio: Gladys habla directamente con sus luces.

![Gladys, la integración y sus luces Yeelight: las luces envían sus estados por una conexión abierta cada una, los comandos salen de Gladys y la búsqueda pasa por el broadcast que Gladys envía en el puerto UDP 1982](images/overview.svg)

## Funciones

La integración se adapta a lo que sabe hacer cada luz — una luz anuncia ella misma sus capacidades, y solo se crean las funciones realmente disponibles:

| Función                  | Luces afectadas                                       |
| ------------------------ | ----------------------------------------------------- |
| Encender / apagar        | Todas                                                 |
| Brillo (1 a 100 %)       | Todas las luces regulables                            |
| Color (RGB)              | Modelos de color (`color`, tiras, lámparas de mesita) |
| Temperatura de color     | Modelos de blanco regulable y de color                |
| Luz ambiental            | Plafones y barras de luz con retroiluminación         |
| Luz nocturna (modo luna) | Plafones                                              |

### Los estados llegan en tiempo real

Sus luces **envían** ellas mismas sus cambios de estado: la integración mantiene una conexión abierta con cada luz, y Gladys recibe el nuevo valor en el momento en que cambia — también cuando usa la aplicación Yeelight, el mando o el interruptor de pared. No hay ningún intervalo de consulta que ajustar.

## Requisitos

### Activar «Control LAN» — imprescindible

Es **el paso que no hay que olvidar**: por defecto, una luz Yeelight rechaza cualquier comando local. Sin esta opción, la luz no se encontrará ni se podrá controlar.

Para cada luz, en la aplicación **Yeelight**:

1. Abra la luz.
2. Vaya a **Ajustes** (icono arriba a la derecha).
3. Active **Control LAN** («LAN Control», también llamado «Modo desarrollador»).

> Hay que repetirlo para cada luz, una por una. Es un ajuste guardado en la propia luz.

### Red

- Gladys y sus luces deben estar en la **misma subred** para que funcione la búsqueda automática.
- La búsqueda difunde una petición en broadcast por el puerto UDP 1982. **Un broadcast nunca atraviesa un router**: si sus luces están en otra VLAN u otra subred que Gladys, la búsqueda no las encontrará — es un límite de la red, no un ajuste. Alargar la duración de la búsqueda no cambia nada.
- En ese caso, añada sus luces **a mano** (ver más abajo): el control, en cambio, va por TCP directo y funciona perfectamente entre subredes siempre que estén enrutadas.

## Configuración

### 1. Descubrir sus luces

Una vez activado «Control LAN», vaya a la pantalla **Descubrir** de la integración e inicie una búsqueda. Sus luces aparecen con su nombre (el que les dio en la aplicación Yeelight), listas para añadirse. **Sin ninguna dirección IP que escribir.**

![Dos fuentes alimentan la pantalla Descubrir: la búsqueda en la red, cuyas respuestas contienen el identificador de fábrica, el modelo, las capacidades y el estado, y las luces añadidas a mano, consultadas por TCP; ambas dan un dispositivo por luz](images/discovery.svg)

### 2. Duración de la transición

Ajusta el fundido aplicado a cada cambio (encendido, regulación, color). El valor por defecto de **500 ms** da una transición suave y natural. Ponga **0** para un cambio instantáneo.

### 3. Luces no encontradas por la búsqueda

Dos casos llevan hasta aquí, y el segundo es el más habitual:

- «Control LAN» no está activado en la luz (ver Requisitos);
- **sus luces están en otra subred / VLAN que Gladys** — la búsqueda no puede alcanzarlas por definición, pero el control funciona.

Añada entonces su dirección en **Luces añadidas a mano**, separadas por comas (el puerto es opcional, 55443 por defecto):

```
192.168.1.42, 192.168.1.43:55443
```

Una dirección IPv6 se escribe entre corchetes: `[fe80::1]` o `[fe80::1]:55443`. Una luz declarada aquí y encontrada también por la búsqueda aparece una sola vez, con la identidad que le da la búsqueda.

> **Importante:** asigne a estas luces una **dirección IP fija** en su router. A diferencia de una luz encontrada por la búsqueda — identificada por su número de serie, que nunca cambia —, una luz añadida a mano se identifica por su dirección. Si cambia su concesión DHCP, Gladys la verá como una luz diferente.

### 4. Duración de la búsqueda

Tiempo durante el que la búsqueda escucha las respuestas. 5 segundos bastan en la gran mayoría de los casos; aumente este valor si su red está muy cargada y faltan algunas luces.

## Acciones disponibles

- **Probar la conexión**: lanza una búsqueda e indica cuántas luces han respondido.
- **Reconectar las luces**: cierra todas las conexiones y las vuelve a abrir. Útil tras un corte de corriente o un cambio en la red.

## Conviene saber

### Ajustar un color en una luz apagada

Una luz Yeelight rechaza los comandos de color, temperatura y brillo mientras está apagada. La integración **la enciende automáticamente** antes de aplicar su ajuste: hacer clic en un color enciende la luz en ese color, que es lo que se espera.

![Cuando elige un color en una luz apagada, la integración la enciende primero y luego envía el color; la luz comunica después su nuevo estado](images/commands.svg)

El estado de encendido se conoce por lo que la luz ya ha comunicado: una luz ya encendida no se vuelve a encender — eso relanzaría su fundido, de forma visible.

### El brillo empieza en 1 %, no en 0 %

Una luz Yeelight no tiene estado «0 %»: el cero es el apagado. Poner el brillo a 0 en Gladys **apaga** por tanto la luz.

### El color mostrado en modo blanco

Cuando una luz está en modo blanco (temperatura de color), sigue recordando el último color usado. Gladys no lo muestra a propósito como color activo, para no enseñar un color que la luz no está mostrando.

### Los plafones tienen dos luces independientes

Un plafón con retroiluminación (ceiling10, barras de luz…) expone **dos luces separadas**, y Gladys las nombra explícitamente:

- **Main light**, **Main brightness**, **Main colour**, **Main colour temperature** (luz principal);
- **Ambient light**, **Ambient brightness**, **Ambient colour**, **Ambient colour temperature** (luz ambiental).

Cada una se enciende y se apaga independientemente de la otra. Para controlar ambas de un solo gesto, cree una **escena** de Gladys que actúe sobre los dos interruptores: es la forma prevista por Gladys de agrupar varios comandos.

La temperatura de color ambiental solo aparece en los modelos cuya retroiluminación puede regular su blanco — el control cálido/frío que la aplicación Yeelight muestra junto a la rueda de color del anillo.

En una luz sin retroiluminación solo hay una luz, y las etiquetas siguen siendo sencillas (**On/Off**, **Brightness**, **Colour**, **Colour temperature**). Puede renombrar cada función en Gladys.

Si su plafón enciende o apaga su anillo a la vez que la luz principal, no es cosa de Gladys: es la opción **«Encendido/apagado automático con la luz principal»** de la aplicación Yeelight. Desactívela para controlar cada luz por separado.

### La temperatura de color

El control de temperatura sigue el degradado de Gladys: **a la izquierda, una luz fría y azulada; a la derecha, una luz cálida y anaranjada.** La integración convierte automáticamente este valor a los Kelvin que entiende la luz, respetando el rango real de su modelo (2700–6500 K en un plafón, 1700–6500 K en una bombilla de color).

### Límites de las luces

Cada luz acepta **4 conexiones simultáneas** y **60 comandos por minuto**. La integración solo abre una conexión por luz y suaviza automáticamente las ráfagas de comandos, pero tenga en cuenta estos límites si también controla sus luces desde otras aplicaciones al mismo tiempo.

## Solución de problemas

| Síntoma                                            | Causa más probable                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| No se encuentra ninguna luz                        | «Control LAN» no está activado en la aplicación Yeelight                                         |
| Solo se encuentra una luz de varias                | La opción solo está activada en esa luz — se ajusta luz por luz                                  |
| Una luz desaparece y luego vuelve                  | Corte de Wi-Fi o interruptor de pared: la integración se reconecta sola, espaciando los intentos |
| Una luz añadida a mano pasa a ser desconocida      | Su dirección IP ha cambiado — asígnele una dirección fija en su router                           |
| Los comandos dejan de funcionar al cabo de un rato | Otro programa ocupa las 4 conexiones de la luz                                                   |
| Una luz añadida a mano se ignora                   | Su dirección ha cambiado, o faltan los corchetes alrededor de una dirección IPv6                 |
