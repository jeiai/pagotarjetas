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

## Reset de contrasena por correo

Para enviar codigos temporales en Render, configura estas variables de entorno:

- `RESEND_API_KEY`: API key de Resend.
- `RESET_EMAIL_FROM`: remitente verificado, por ejemplo `Pagos Tarjetas <no-reply@tudominio.com>`.
- `RESET_CODE_SECRET`: texto secreto largo para firmar los codigos temporales.
