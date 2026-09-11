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
- `OPENAI_MODEL`: modelo con vision, opcional. Si no lo configuras, usa `gpt-4.1-mini`.

La app acepta hasta 15 archivos PNG/JPG/PDF a la vez, o un ZIP que contenga esos formatos.

El limite de 15 incluye los documentos dentro del ZIP. Cada documento descomprimido puede pesar hasta 12 MB y el envio completo hasta 80 MB. Se admiten ZIP estandar sin contrasena, con compresion Deflate o sin compresion; no ZIP64 ni archivos divididos. Si falla el analisis de un documento, se conservan los resultados correctos y se muestran los archivos que deben reintentarse. La carga manual no admite ZIP: usa **Carga automatica**.

Ejecuta `npm test` para probar login, persistencia al reiniciar, errores del panel, lectura de ZIP y procesamiento parcial. Las pruebas usan datos temporales y respuestas de IA simuladas; no comprueban credenciales ni vision en produccion.
