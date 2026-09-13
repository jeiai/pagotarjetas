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

En desarrollo local, los usuarios, tarjetas y estados se guardan en `data/db.json` y los archivos en `uploads/`. Al configurar Supabase, la app usa su base de datos y un bucket privado para ambos tipos de datos, sin depender del disco de Render.

Para usar un disco persistente, configura `DATA_DIR` con su directorio de montaje. La base se guardara en `DATA_DIR/db.json` y los documentos en `DATA_DIR/uploads/`. Al cambiar de ubicacion, copia antes la base y los archivos existentes a esas rutas. Sin almacenamiento persistente, un despliegue que reemplace el sistema de archivos puede perder cuentas y sesiones. Esta opcion admite una sola instancia del servidor.

### Render gratis con Supabase

Render gratis no admite discos persistentes y pierde los archivos locales al reiniciar, redesplegar o suspender el servicio. El almacenamiento externo evita que desaparezcan las cuentas y las capturas por esos eventos. La base gratuita de Render expira a los 30 dias; no la uses para esta solucion. Consulta [Render Free](https://render.com/docs/free).

1. Crea un proyecto dedicado en el plan **Free** de [Supabase](https://supabase.com/dashboard). El plan incluye 500 MB de base y 1 GB para archivos; puede pausarse tras una semana sin actividad y requiere reactivarlo desde su panel. Revisa los [limites vigentes](https://supabase.com/pricing).
2. En **SQL Editor**, ejecuta [supabase/setup.sql](supabase/setup.sql). Crea `tarjetas_state` y el bucket privado `tarjetas-documentos`. La tabla no permite acceso a clientes `anon` ni `authenticated`; solo el servidor accede con su clave secreta. Reejecutar el SQL no vacia los datos existentes. Usa un proyecto dedicado sin politicas generales que den acceso a otros buckets.
3. En Render, en el servicio existente **pagotarjetas → Environment**, agrega `SUPABASE_URL` y `SUPABASE_SECRET_KEY`. Copia la URL del proyecto y la clave `sb_secret_...` desde Supabase **Settings → API Keys / Connect**. La clave antigua `service_role` tambien funciona como `SUPABASE_SERVICE_ROLE_KEY`. No uses la clave publica/`anon`, no pegues secretos en el chat, en `public/` ni en GitHub. Conserva las variables de OpenAI y del correo que ya existen.
4. **Antes de desplegar**, respalda cualquier `db.json` y carpeta de documentos que todavia existan en el servidor anterior. Si hay datos que conservar, usa la migracion descrita abajo. Configurar Supabase no recupera archivos ya borrados.
5. Despliega el codigo actualizado con `npm start`. Al arrancar, la app comprueba la base y que el bucket sea privado; si la configuracion falla, no inicia con una base local vacia. Render sin Supabase ni `DATA_DIR` configurado tambien detiene el arranque para evitar nuevas cuentas efimeras. `DATA_DIR` por si solo no crea ni contrata un disco.
6. Comprueba registro, cierre de sesion, nuevo acceso y apertura de una captura. Reinicia el servicio y verifica otra vez los mismos datos.

Con las variables disponibles en una terminal, `npm run storage:check` verifica conectividad, privacidad del bucket y cantidades de registros, sin imprimir correos, contrasenas ni claves. Node no lee `.env` automaticamente; para una comprobacion local con un archivo privado usa `node --env-file=.env scripts/check-storage.js`.

Tras desplegar, `GET /api/health` comprueba la base y el bucket y devuelve `{"ok":true,"storage":"supabase"}`. No muestra usuarios, cantidades de registros ni credenciales. Si el almacenamiento no responde, devuelve 503. Esto permite verificar la conexion publicada sin compartir claves de Supabase.

Las contrasenas mantienen el hash existente y los archivos se sirven a traves de la app, despues de comprobar la cuenta propietaria. Si Supabase falla o esta pausado, la app devuelve un error de almacenamiento (503), sin reemplazar la base. Si dos operaciones intentan escribir sobre versiones distintas, la mas antigua devuelve 409 para reintentar y no borra cambios ajenos. El backend guarda el estado de esta app familiar en una fila JSONB con revision; esta pensado para poco volumen, no para escalar a muchas cuentas. Una carga cuyo archivo se guardo pero cuyo registro fallo puede dejar un objeto privado sin referencia; no se borran objetos automaticamente.

### Recuperar desde un respaldo existente

La migracion solo acepta un destino vacio. Conserva IDs, hashes, tarjetas y pagos, copia los documentos con nombres nuevos y cierra las sesiones anteriores. No modifica ni borra el respaldo. Si falta un archivo referenciado, falla antes de copiar datos.

```powershell
npm run storage:migrate -- "C:\respaldo\db.json" "C:\respaldo\uploads"
```

Si usas un `.env` local, ejecuta `node --env-file=.env scripts/migrate-storage.js "C:\respaldo\db.json" "C:\respaldo\uploads"`. No ejecutes registro ni otras escrituras en el destino mientras se realiza la migracion. Si falla la conexion, revisa con `storage:check` si se completo antes de volver a ejecutar. Una interrupcion puede dejar archivos privados copiados sin referencia, pero no sobrescribe los datos del destino ni elimina los originales.

Sin respaldo ni archivos originales disponibles no es posible reconstruir la cuenta y los pagos que Render ya elimino. Una vez conectado y comprobado el almacenamiento permanente, el usuario puede crear de nuevo su cuenta y volver a subir los documentos que conserve.

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

Ejecuta `npm test` para probar login, persistencia al reiniciar, errores del panel, lectura de ZIP, procesamiento parcial, archivos privados, migracion y conflictos de escritura. Las pruebas usan datos temporales y respuestas simuladas de Supabase y de IA; no comprueban las credenciales, las politicas reales de Supabase ni la vision en produccion.

La carga automatica muestra progreso por documento y conserva cada archivo y lectura para revision. Cada lectura tiene un limite de 45 segundos y el lote completo, de 3 minutos de analisis. Si se interrumpe la conexion, revisa los archivos ya recibidos antes de reintentar. El navegador cancela la espera tras 90 segundos sin noticias del servidor o 4 minutos desde el inicio del envio. Los mensajes distinguen espera agotada, problemas de conexion, configuracion y saldo/cuota de OpenAI. No se reintentan documentos automaticamente.

## Revisar y corregir importes

La IA debe transcribir la etiqueta y el importe que sustentan cada monto. El pago minimo se solicita por separado del pago para no generar intereses, del saldo total y de los pagos minimos mas cuotas. Un dato ausente, ilegible o ambiguo se guarda como `null` y aparece como **No identificado**, nunca como un cero supuesto. Esto reduce errores, pero la evidencia transcrita tambien debe cotejarse con el original.

En **Pagos registrados**, abre **Revisar y confirmar**, consulta el archivo original y corrige la tarjeta, el periodo, la fecha y los tres montos. Al pulsar **Confirmar importes** se actualiza el resumen. Se aceptan ceros reales; no se permiten montos vacios o negativos. Todos los registros automaticos sin confirmacion quedan fuera del resumen, incluidos los de versiones anteriores: sus ceros no se modifican y se avisa que pueden representar datos que no se leyeron. Las correcciones conservan el archivo, los valores extraidos y un historial de valores anteriores; no requieren volver a subir la captura ni llamar a la IA.

Ante un rechazo de cuenta (401/403/404/429), se detiene el envio de los archivos restantes. Para diagnosticar un 429, busca `[auto-extract] OpenAI rejected extraction` en los logs de Render y consulta `code` y `type`: `credit_balance_exhausted` indica saldo agotado; `project_spend_limit_exceeded`, `organization_spend_limit_exceeded` y `organization_usage_limit_exceeded` indican limites de cuenta; `rate_limit_exceeded` y `slow_down` indican limites temporales. Un error de saldo o limite de cuenta no se resuelve reenviando los archivos. Los mensajes repetidos se agrupan en pantalla y los documentos no enviados se identifican como pendientes.
