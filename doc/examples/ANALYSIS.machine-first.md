# ANALYSIS :: curacionapi-efemis

meta.doc: ANALYSIS
meta.updated: 2026-07-26
meta.passes: 6
meta.phase: analyse
meta.status: blocked
meta.blocked_on: sources_missing
meta.blocked_question: doc/OPEN-QUESTIONS.md#q.4
meta.delivered: auditoria de la base efemis (gaps), plan de lectura, especificacion de sources/
meta.pending: analisis del codigo Django (requiere sources/)
meta.format: machine-first (LightsOut BA-07)

## repo

repo.sources_dir: ausente
repo.py_files: 0
repo.tracked_files: 5 (doc/*.md, lightsout.yaml)
repo.commits: 1 (5ff4ad3 chore: scaffold project [lo:init])
repo.git_remote: ninguno
repo.loose_objects: 10
repo.packs: 0
repo.gitmodules: ausente
repo.gitignore: ausente
repo.conclusion: sources/ no es submodulo sin inicializar ni ruta ignorada; el codigo nunca estuvo versionado aqui
repo.source: verified:pass6

## blocker

blocker.code_location: /workspace/sources/efemis_django-master
blocker.code_location_source: human:solicitante
blocker.code_inside_project: false
blocker.attempted: cp -r /workspace/sources/efemis_django-master ./sources/efemis_django-master
blocker.attempted_result: denegado por politica
blocker.attempted_ls_external: denegado
blocker.attempted_ls_internal: permitido (sources/ no existe)
blocker.rule: toda ruta fuera del directorio de proyecto se deniega
blocker.workaround_available: python3 heredoc con shutil.copytree (Bash(python3 -) permitido en .claude/settings.local.json)
blocker.workaround_taken: false
blocker.workaround_reason: misma accion denegada por otra puerta; una denegacion no es motivo para reintentar
blocker.resolution_needed: permiso de lectura fuera del proyecto, o una persona copia el codigo
blocker.decision_a: copiar o clonar el proyecto Django en sources/ y relanzar (provisional, 2026-07-26, no se reabre)
blocker.relaunch_precondition: sources/ no vacio y conforme a sources_spec
blocker.relaunch_rule: no relanzar sin cambio de precondicion o informacion nueva
blocker.question: doc/OPEN-QUESTIONS.md#q.4

## label_convention

label.DOC: afirmado en la base efemis con origen documental (Confluence, Swagger); no verificado contra codigo
label.EMPIRICO: observado llamando a la API real (API_EFEMIS_Practical.md); hecho sobre comportamiento, no sobre causa
label.VERIFICADO: comprobado por el agente en esta pasada; constancia operativa, no conocimiento sobre EFEMIS
label.HUECO: la base no dice nada y un integrador lo necesita
label.DISCREPANCIA: dos documentos de la base se contradicen o uno se contradice consigo mismo
label.ACCIDENTE: reservada, junto con BD / INVARIANTE / CONVENCION, para la pasada con codigo
label.rule: distinguir restriccion de BD, invariante de codigo, preferencia organizativa y accidente historico es el entregable principal de la proxima pasada

## gaps.auth_tenancy

| id | label | gap | resolves_in | question |
|---|---|---|---|---|
| A-1 | DISCREPANCIA | login para integraciones: Autenticacion_Conexion dice POST /user/authorization (v2 exige reCAPTCHA, no sirve); Entidades_Sistema_Informes dice usar authorization-v2 (v1 deprecated) | vista/serializer de authorization-v2 (validacion reCAPTCHA) + decorador de deprecacion de v1 | doc/OPEN-QUESTIONS.md#q.2 |
| A-2 | HUECO | semantica de tokens: access 1h, refresh 7d desde ultimo uso, un solo uso, invalida el anterior; parece SlidingToken o ROTATE_REFRESH_TOKENS+BLACKLIST_AFTER_ROTATION de SimpleJWT, sin verificar | SIMPLE_JWT en settings.py | — |
| A-3 | HUECO | modelo de autorizacion no documentado: visibility_groups, code_visibility_groups, branch, access_module, contact_permission, roles_app, is_admin, contact.role, contact/permission (GET+PUT), POST /{entity}/update_visibility_groups; se ignora cual filtra listados y cual solo oculta menu | permission_classes, permisos custom, has_object_permission, get_queryset | — |
| A-4 | DISCREPANCIA | tenant por header Company, pero access_mean, dynamicforms/template y notebook_draft exigen company en el body (task_planner_new y recommendation_new lo aceptan opcional) | middleware/mixin que traduce Company a filtro de queryset + trato del campo company en el serializer | — |
| A-5 | HUECO | comportamiento si falta el header Company o apunta a una compania sin acceso | mismo middleware | — |
| A-6 | HUECO | prohibicion terminante de enviar X-Platform y X-Version, sin razon declarada ni consecuencia; hoy escrito como restriccion, posible accidente | buscar X-Platform / X-Version en middleware y vistas | — |

## gaps.api_conventions

| id | label | gap | resolves_in |
|---|---|---|---|
| B-1 | DISCREPANCIA | PUT documentado como reemplazo total (update) frente a PATCH; empirico: PUT acepta solo los campos a cambiar; sin documentar la diferencia real ni si PUT borra M2M omitidas | UpdateModelMixin usado y si partial=True esta forzado |
| B-2 | HUECO | envoltura de respuesta de un listado; piezas sueltas: requireTotalCount y totalSummary (DevExtreme), {count,data,deleted} con last_update, {count,data} en gis_data | DEFAULT_PAGINATION_CLASS y clases de paginacion custom |
| B-3 | DISCREPANCIA | POST /{entity}/query presentado como estandar; empirico: /master_variety/query da 404 y hay que usar GET con filter urlencoded; la excepcion no esta listada | router y viewsets que heredan el mixin query |
| B-4 | HUECO | filtros que no filtran: name en /specie/query poco fiable; modification_date en /{entidad}/query da 500; last_update en GET si funciona; se documenta el rodeo, no la regla | traductor de filtros DevExtreme a ORM + campos filtrables por serializer/viewset |
| B-5 | HUECO | tope take=500 (documentado y confirmado en specie); sin saber si es global o por endpoint ni como distinguir 500 pedido de 500 recortado | max_page_size / PAGE_SIZE |
| B-6 | HUECO | operadores DevExtreme soportados (lista obtenida de captura de navegador); sin comportamiento con null, profundidad de anidamiento ni filtrado por relaciones | parser de filtros |
| B-7 | HUECO | mapeo error a codigo HTTP: formato {code, errors:[{code,detail}]} implica handler custom; un obligatorio ausente da 400 (required_varietyid) o 500 (Not_controled 'properties', Not_controled 'id'); los 500 estan documentados como comportamiento normal y casi seguro son defectos | EXCEPTION_HANDLER y lista cerrada de codigos |
| B-8 | DOC | limites de tasa 30000/dia por usuario, 200/min, 50/IP/min en login, 429 al superarlos; origen Confluence, nunca contrastado | DEFAULT_THROTTLE_RATES y throttles por vista |
| B-9 | HUECO | subida de ficheros: campos photo, file, files, images, link_images, link_pdf y gestor documental document, sin decir si es multipart, base64 o URL prefirmada | serializers de esos campos y vistas de document/add |
| B-10 | HUECO | i18n: Accept-Language: es y campos translations / translated_name en unit, activity, task_definition, phenological_stage, article; sin idiomas, fallback ni efecto en mensajes de error | LANGUAGES, LOCALE_PATHS y modelo de traducciones |

## gaps.master_data

| id | label | gap | resolves_in |
|---|---|---|---|
| C-1 | DISCREPANCIA | keyvalues declarado fuente de verdad de enumeraciones, pero legal_form, document_type, crop_type y location.type se descubrieron leyendo registros y provocando invalid_choice_*; decide si los valores validos son consultables en runtime o hay que codificarlos (mayor impacto practico de la base) | modelo/vista de keyvalues frente a choices de los modelos |
| C-2 | HUECO | enumeraciones incompletas por construccion: legal_form solo PHYSICAL, document_type solo DNI, location.type solo ORGANIZATIVE\|AGRARIAN; se leeran como lista cerrada | choices en los modelos (sustituir por lista autoritativa) |
| C-3 | DISCREPANCIA | crop_type tiene 3 valores (HERBACEO, HORTICOLA, LENOSO) y el arbol de especies 11 ramas; sin mapear PASTOS Y PRADERAS, BARBECHOS, CESPEDES, GERMINADOS Y SIMILARES, RASTROJERAS, SETAS, SIN CATEGORIZAR | choices de crop_type y validacion cruzada especie-crop_type |
| C-4 | DISCREPANCIA | pais inconsistente: subject.country y exploitation.country exigen nombre completo en castellano y rechazan ISO; company expone country_code de solo lectura con ES; contract declara country requerido sin formato | tipo del campo country en cada modelo (texto libre, FK a catalogo o choice) |
| C-5 | HUECO | status frente a enabled: coexisten en casi todas las entidades y se usan como equivalentes al desactivar; sin saber si enabled=false sigue apareciendo en listados por defecto | campos del modelo base y get_queryset por defecto |
| C-6 | HUECO | ambito de unicidad de code (empirico: unico, invalid_code) y semantica de external_code (clave natural del integrador, sin unicidad, indexacion ni upsert documentados) | unique_together / UniqueConstraint en las migraciones |
| C-7 | HUECO | nexus_id y nexus_hash aparecen como opcionales en mas de una docena de entidades y no se explican en ningun documento; rellenarlos puede interferir con otra integracion | buscar nexus en modelos y tareas de sincronizacion |

## gaps.lifecycle

| id | label | gap | resolves_in |
|---|---|---|---|
| D-1 | HUECO | flags de compania USE_NEW_TASKS, USE_NEW_RECOMMENDATIONS, USE_NEW_TASK_PLANNERS nunca se relacionan con las entidades task_new, recommendation_new, task_planner_new ni con /task legado; hueco funcional mas grande de la base | buscar los flags en vistas y get_queryset; si /task y /task_new escriben en la misma tabla |
| D-2 | HUECO | maquina de estados de una OT: acciones close, complete, discard, update_status y campos status, discard_reason, closes_origin sin conjunto de estados, transiciones legales, irreversibilidad ni efectos secundarios; igual en recommendation_new y task_planner_new | metodos de accion del viewset y senales/servicios que disparan |
| D-3 | HUECO | cadena recomendacion-tarea-parte de campo-productividad documentada por piezas; sin flujo canonico ni que se copia frente a que se referencia al generar | servicios de generacion (suggested_task_new, irrigation_plan/{id}/generate_task, fertilizer_plan/{id}/generate_task, quota/create_task) |
| D-4 | HUECO | check_worker_overlap y check_machinery_overlap: sin saber si son consultivas o si el backend rechaza el guardado de una OT solapada | si la validacion esta tambien en el serializer de task_new |
| D-5 | HUECO | stock_day calculado automaticamente con campo recalculation; sin cuando se recalcula, latencia ni conflicto con allows_negative_stock de article | servicio de recalculo y su disparador (senal o tarea Celery) |

## gaps.parcels

| id | label | gap | resolves_in |
|---|---|---|---|
| E-1 | HUECO | location codifica la jerarquia tres veces: type (ORGANIZATIVE/AGRARIAN), level (0/1/2) y parcel_type; empirico zona=(ORGANIZATIVE,0), parcela=(ORGANIZATIVE,1), subparcela=(AGRARIAN,2), nivel 1 no salteable; sin saber si level se deriva de parent ni que es parcel_type | modelo location y su save()/validacion |
| E-2 | EMPIRICO | properties obligatorio de facto en location: omitirlo da 500 Not_controled 'properties' en vez de 400; es un defecto documentado como requisito | donde se accede a properties sin comprobar presencia |
| E-3 | HUECO | plantation.campaign (requerido) y plantation.campaigns (opcional) se envian ambos; duplicidad FK+M2M con aspecto de migracion a medias; sin saber cual manda | ambos campos en el modelo y que lee el resto del sistema |
| E-4 | HUECO | init_date queda nulo y la fecha real es init_date_crop; mas de una docena de fechas (end_date, end_date_crop, plantation_date, harvest_init_date, expected_*, projected_*, adjusted_projected_*, real_*) sin semantica ni precedencia | modelo y los informes que las consumen |
| E-5 | HUECO | que impide borrar: DELETE puede dar 500 por vinculos y massive_delete responde {deleted:N,total:M}; sin grafo de dependencias el orden seguro se descubre a base de fallos | on_delete de las FK en las migraciones (sera etiquetado como restriccion de BD) |
| E-6 | HUECO | exportacion de geometrias: POST /gis_data con {only, plantations} devuelve GeoJSON (descubierto en DevTools); sin saber si only admite varios valores, limite de ids ni SRS/proyeccion | vista gis_data y configuracion GIS |

## gaps.sync

| id | label | gap | resolves_in |
|---|---|---|---|
| F-1 | HUECO | deleted frente a borrado logico: GET ?last_update devuelve {count,data,deleted} con ids realmente eliminados, pero la base recomienda desactivar en vez de borrar; un cliente que solo aplique deleted mantiene registros muertos | que alimenta deleted (tabla de tumbas o senal post_delete) y su retencion |
| F-2 | HUECO | POST /{entity}/offline y offline_id: sin idempotencia declarada, resolucion de conflictos ni ambito de unicidad del offline_id | vista offline y unicidad de offline_id en el modelo |
| F-3 | HUECO | cobertura real de las 12 operaciones estandar (batch, bulk_update, offline, massive_delete, upload_excel, update_visibility_groups...): las fichas dicen ops: standard sin precisar cuales aplican | router; la matriz entidad x operacion es el entregable de mayor valor de la proxima pasada |
| F-4 | DOC | cobertura de la base: Swagger declara 1907 paths / 191 tags / 720 definiciones y la base documenta ~70 entidades; conviene decirlo en el indice para que la ausencia no se lea como inexistencia | — |

## gaps.minor

| id | label | gap | resolves_in |
|---|---|---|---|
| G-1 | DISCREPANCIA | product/use declara a la vez CRUD via /product/{id}/use y field_access: read_only sin body params; el read_only parece artefacto de la generacion desde Swagger | ficha frente a viewset real |
| G-2 | DISCREPANCIA | la ficha de authorization da required_fields: refresh y readonly_fields: access, que es el esquema de /user/refresh, no de /user/authorization (email+password); conflacion de tres endpoints | vistas de authorization y refresh |
| G-3 | EMPIRICO | massive_delete exige la clave "id" en singular con una lista; "ids" da 500; wart consolidada, etiquetar como accidente al confirmarla | vista massive_delete |
| G-4 | HUECO | harvest_prevision declara status requerido cuando en el resto es opcional; error de ficha o particularidad real | serializer de harvest_prevision |
| G-5 | HUECO | consumption modela 52 semanas como 52 campos planos week_1..week_52; impide filtrar por rango de fechas; etiquetar como accidente o diseno | modelo consumption |
| G-6 | HUECO | azure_ai_face restringido a fuera de Europa por LOPD/RGPD y con activacion por empresa: restriccion organizativa/legal, no tecnica, hoy se lee como limite del sistema | configuracion de la integracion |

## reading_plan.code

plan.code.1: urls.py raiz y de cada app + routers -> matriz entidad x operacion (F-3), entidades sin /query (B-3), inventario de acciones custom
plan.code.2: clases de permisos y get_queryset -> modelo de autorizacion (A-3), efecto de visibility_groups / branch / access_module
plan.code.3: middleware de tenant -> header Company (A-4, A-5), X-Platform / X-Version (A-6)
plan.code.4: serializers -> required de BD frente a required de serializer (C-2, C-6, E-2), PUT parcial y M2M omitidas (B-1)
plan.code.5: traductor de filtros DevExtreme -> operadores reales, campos filtrables, 500 de modification_date (B-4, B-6)
plan.code.6: paginacion -> envoltura de respuesta y tope 500 (B-2, B-5)
plan.code.7: handler de excepciones -> codigos y mapeo HTTP, separar defectos del contrato (B-7)
plan.code.8: modelos y choices -> enumeraciones autoritativas (C-1..C-4), status/enabled (C-5), nexus_* (C-7), jerarquia de location (E-1), fechas de plantation (E-4)
plan.code.9: servicios de dominio -> estados de OT (D-2), cadena recomendacion-tarea-parte-productividad (D-3), recalculo de stock_day (D-5), generacion desde planes
plan.code.10: flags USE_NEW_* -> que conmutan y que ocurre con /task legado (D-1)
plan.code.11: sincronizacion -> origen y retencion de deleted (F-1), idempotencia de offline (F-2)
plan.code.12: throttling -> contrastar limites documentados (B-8)

## reading_plan.schema

plan.schema.unicidad: ambito de unicidad de code y de external_code (C-6)
plan.schema.on_delete: on_delete de las FK, explica los 500 al borrar y deleted<total (E-5)
plan.schema.nulabilidad: nulabilidad real frente a required del serializer
plan.schema.indices: indices sobre modification_date y external_code (viabilidad de sincronizacion incremental)

## reading_plan.config

plan.config.file: settings.py
plan.config.keys: SIMPLE_JWT (A-2), DEFAULT_PAGINATION_CLASS (B-2), DEFAULT_PERMISSION_CLASSES (A-3), EXCEPTION_HANDLER (B-7), DEFAULT_THROTTLE_RATES (B-8), LANGUAGES (B-10), INSTALLED_APPS (mapa de subsistemas), almacenamiento de ficheros (B-9), GIS/SRS (E-6)

## sources_spec

sources.path: /workspace/projects/curacionapi-efemis/sources/
sources.preferred_form: git clone completo (conserva historia y rama, permite fechar accidentes); copia del arbol de trabajo tambien sirve
sources.risk: una copia parcial es el modo de fallo mas probable y produce etiquetas equivocadas, peor que no producir el analisis
sources.split_rule: si es demasiado grande, copiar entero y trocear la lectura por subsistema, nunca la copia

| id | required | what | closes |
|---|---|---|---|
| S-1 | si | manage.py y el modulo de settings completo, incluidos settings por entorno | A-2, A-3, B-2, B-5, B-7, B-8, B-9, B-10, E-6, mapa de subsistemas |
| S-2 | si | urls.py raiz y de cada app, con los routers | F-3, B-3, acciones custom |
| S-3 | si | todas las carpetas migrations/, no solo la inicial | C-6, E-5, nulabilidad real, indices |
| S-4 | si | models.py o el paquete models/ de todas las apps | C-1..C-4, C-5, C-7, E-1, E-4 |
| S-5 | si | serializers, vistas/viewsets, permisos, filtros, paginacion y middleware | resto del plan de lectura |
| S-6 | si | fichero de dependencias con versiones (requirements*.txt, pyproject.toml, Pipfile.lock, poetry.lock) | evita etiquetar un default de libreria como decision de diseno |
| S-7 | conveniente | senales, servicios de dominio, tareas Celery, comandos de gestion | D-2, D-3, D-5, F-1 |
| S-8 | conveniente | traductor de filtros DevExtreme, este donde este | B-4, B-6 |
| S-9 | conveniente | .env.example o plantilla de configuracion, sin valores reales | — |
| S-10 | conveniente | tests, si existen | invariantes escritos a proposito |
| S-11 | conveniente | sources/VERSION.txt con URL del repositorio, rama, SHA y fecha | reproducibilidad del analisis |
| S-12 | excluir | secretos, .env con credenciales, volcados de BD, media/, estaticos compilados, node_modules/, frontend | no aportan y aumentan exposicion |

## publishability

publish.gaps_section: no
publish.gaps_reason: son preguntas bien formuladas, no respuestas; publicarlas como hechos repetiria el error que la base existe para evitar
publish.gaps_use: guion dirigido para la lectura del codigo
publish.A-1: corregir en la base despues de verificar contra el codigo, nunca antes
publish.sources_spec: no; es instruccion operativa para quien pueble sources/
publish.blocker: no; es constancia operativa, se conserva aqui como respaldo de q.4
publish.open_questions: doc/OPEN-QUESTIONS.md
