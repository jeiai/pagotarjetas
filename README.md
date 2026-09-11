# Control de tarjetas

App web para registrar tarjetas de credito, subir capturas o PDF de estados de cuenta y dar seguimiento a:

- Pago minimo
- Monto para no generar intereses
- Monto total
- Fecha limite
- Estado del pago

## Uso

```powershell
npm start
```

Abre `http://127.0.0.1:4173`.

Cada persona crea su cuenta con correo y contrasena. Los datos se muestran solo dentro de la cuenta que inicio sesion.

## Datos

Los usuarios, tarjetas y estados se guardan en `data/db.json`. Los archivos subidos se guardan en `uploads/`.

Para usar un disco persistente, configura `DATA_DIR` con su directorio de montaje. La base se guardara en `DATA_DIR/db.json` y los documentos en `DATA_DIR/uploads/`. Al cambiar de ubicacion, copia antes la base y los archivos existentes a esas rutas. Sin almacenamiento persistente, un despliegue que reemplace el sistema de archivos puede perder cuentas y sesiones. Esta opcion admite una sola instancia del servidor.

## Reset de contrasena por correo

Para enviar codigos temporales en Render, configura estas variables de entorno:

- `RESEND_API_KEY`: API key de Resend.
- `RESET_EMAIL_FROM`: remitente verificado, por ejemplo `Pagos Tarjetas <no-reply@tudominio.com>`.
- `RESET_CODE_SECRET`: texto secreto largo para firmar los codigos temporales.

Si el codigo no llega, revisa los logs del servicio en Render. La app escribe si Resend acepto el correo o si lo rechazo por configuracion. El remitente de `RESET_EMAIL_FROM` debe pertenecer a un dominio verificado en Resend.

## Extraccion automatica de estados de cuenta

Para leer capturas automaticamente, configura estas variables en Render:

- `OPENAI_API_KEY`: API key de OpenAI.
- `OPENAI_MODEL`: modelo con vision y salidas estructuradas (`json_schema`), opcional. Si no lo configuras, usa `gpt-4.1-mini`.

La app acepta hasta 15 archivos PNG/JPG/PDF a la vez, o un ZIP que contenga esos formatos.

El limite de 15 incluye los documentos dentro del ZIP. Cada documento descomprimido puede pesar hasta 12 MB y el envio completo hasta 80 MB. Se admiten ZIP estandar sin contrasena, con compresion Deflate o sin compresion; no ZIP64 ni archivos divididos. Si falla el analisis de un documento, se conservan los resultados correctos y se muestran los archivos que deben reintentarse. La carga manual no admite ZIP: usa **Carga automatica**.

Ejecuta `npm test` para probar login, persistencia al reiniciar, errores del panel, lectura de ZIP y procesamiento parcial. Las pruebas usan datos temporales y respuestas de IA simuladas; no comprueban credenciales ni vision en produccion.

La carga automatica muestra progreso por documento y conserva cada archivo y lectura para revision. Cada lectura tiene un limite de 45 segundos y el lote completo, de 3 minutos de analisis. Si se interrumpe la conexion, revisa los archivos ya recibidos antes de reintentar. El navegador cancela la espera tras 90 segundos sin noticias del servidor o 4 minutos desde el inicio del envio. Los mensajes distinguen espera agotada, problemas de conexion, configuracion y saldo/cuota de OpenAI. No se reintentan documentos automaticamente.

## Revisar y corregir importes

La IA debe transcribir la etiqueta y el importe que sustentan cada monto. El pago minimo se solicita por separado del pago para no generar intereses, del saldo total y de los pagos minimos mas cuotas. Un dato ausente, ilegible o ambiguo se guarda como `null` y aparece como **No identificado**, nunca como un cero supuesto. Esto reduce errores, pero la evidencia transcrita tambien debe cotejarse con el original.

En **Pagos registrados**, abre **Revisar y confirmar**, consulta el archivo original y corrige la tarjeta, el periodo, la fecha y los tres montos. Al pulsar **Confirmar importes** se actualiza el resumen. Se aceptan ceros reales; no se permiten montos vacios o negativos. Todos los registros automaticos sin confirmacion quedan fuera del resumen, incluidos los de versiones anteriores: sus ceros no se modifican y se avisa que pueden representar datos que no se leyeron. Las correcciones conservan el archivo, los valores extraidos y un historial de valores anteriores; no requieren volver a subir la captura ni llamar a la IA.

Ante un rechazo de cuenta (401/403/404/429), se detiene el envio de los archivos restantes. Para diagnosticar un 429, busca `[auto-extract] OpenAI rejected extraction` en los logs de Render y consulta `code` y `type`: `credit_balance_exhausted` indica saldo agotado; `project_spend_limit_exceeded`, `organization_spend_limit_exceeded` y `organization_usage_limit_exceeded` indican limites de cuenta; `rate_limit_exceeded` y `slow_down` indican limites temporales. Un error de saldo o limite de cuenta no se resuelve reenviando los archivos. Los mensajes repetidos se agrupan en pantalla y los documentos no enviados se identifican como pendientes.
