# Control familiar de tarjetas

App web local para que varios usuarios de una familia registren tarjetas de credito, suban capturas o PDF de estados de cuenta y den seguimiento a:

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

La primera persona crea una cuenta y obtiene un codigo familiar. Las demas personas usan ese codigo al registrarse para compartir el mismo tablero.

## Datos

Los usuarios, tarjetas y estados se guardan en `data/db.json`. Los archivos subidos se guardan en `uploads/`.
