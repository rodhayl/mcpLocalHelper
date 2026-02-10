Servidor MCP para Asistente LLM Local – Requerimientos Técnicos
Introducción
Se propone un servidor MCP (Model Context Protocol) para integrar un modelo de lenguaje local en el flujo de trabajo de desarrollo (p. ej. junto a GitHub Copilot). MCP es un estándar abierto que estandariza cómo las aplicaciones de IA (como los asistentes de código) interactúan con herramientas y fuentes de datos externas
es.wikipedia.org
en.wikipedia.org
. La idea es aprovechar un LLM local (ejecutado en la máquina del desarrollador) para realizar análisis de contexto extensos sin las limitaciones de un servicio en la nube, preservando la privacidad de los datos sensibles. El servidor MCP actuará como puente entre el IDE/Copilot y el LLM local, permitiendo que este acceda de forma controlada a recursos del sistema (código fuente, archivos, etc.) y que sus resultados se integren en la experiencia del desarrollador.
Compatibilidad multiplataforma
Sistema operativo: El servidor MCP debe poder instalarse y ejecutarse en Linux, macOS y Windows. Esto garantiza que desarrolladores en cualquier plataforma puedan utilizarlo. Muchas herramientas populares de LLM local ya enfatizan soporte multiplataforma – por ejemplo, Ollama funciona tanto en Windows, macOS como Linux
pinggy.io
– por lo que es viable lograr esta compatibilidad.
Distribución: Se recomienda proporcionar binarios o instaladores para cada OS, o bien utilizar tecnologías portables (p. ej. una aplicación web local) que funcionen de igual forma en los tres sistemas. En caso necesario, contenedores Docker también podrían utilizarse para garantizar un entorno uniforme en todas las plataformas.
Interfaz gráfica web-based
Interfaz de usuario: El servidor ofrecerá una interfaz gráfica accesible vía navegador web (web-based) para su configuración y uso. Esto hace la herramienta más portable y sencilla de ejecutar (el usuario solo necesita un navegador). La interfaz web permitirá configurar qué servicio/modelo local usar, iniciar/detener el servicio LLM local y visualizar resultados.
Diseño ligero: La UI debe ser simple e intuitiva, mostrando opciones clave sin abrumar. Por ejemplo, una página inicial con un menú para seleccionar el motor LLM local deseado, lista de modelos disponibles y controles básicos (p.ej. un botón para probar una consulta al modelo). Se puede usar un framework web ligero (como un pequeño servidor Flask/FastAPI + HTML o una SPA JavaScript minimalista) para no escribir mucho código personalizado.
Integración con LLMs locales existentes
Soporte de servicios locales: El servidor MCP permitirá configurar hasta 5 de los servicios LLM locales más usados en 2025, de modo que el usuario pueda elegir. En particular, debe integrarse con: Ollama, LM Studio, text-generation-webui, GPT4All y LocalAI
pinggy.io
. Cada uno de estos ofrece una forma sencilla de ejecutar modelos en local:
Ollama: CLI multiplataforma capaz de descargar/ejecutar modelos con un comando y exponer una API local compatible con OpenAI
pinggy.io
pinggy.io
.
LM Studio: Aplicación de escritorio con GUI que incluye un servidor API compatible con OpenAI para uso por desarrolladores
pinggy.io
.
text-generation-webui: Interfaz web flexible para ejecutar modelos (ej. formato llama.cpp GGUF) localmente, con extensiones y opción de API local mediante complementos
pinggy.io
.
GPT4All: Aplicación de escritorio amigable (especialmente en Windows) que permite chat con modelos locales y ofrece plugins; se puede extender para integrarse via su backend o librerías oficiales
pinggy.io
.
LocalAI: Plataforma open-source orientada a desarrolladores, diseñada como reemplazo directo de la API de OpenAI pero ejecutando modelos localmente (soporta múltiples arquitecturas y despliegue en Docker)
pinggy.io
.
Selección de modelo: La interfaz del MCP debe listar los modelos disponibles en el servicio LLM seleccionado. Por ejemplo, si el usuario elige LM Studio u Ollama, se mostrarán los modelos instalados/cargados allí. El usuario podrá elegir el modelo local (GPT-OSS, Llama 4, DeepSeek, Qwen, etc. según tenga descargados) adecuado a su tarea. De ser posible, el servidor puede llamar a las APIs de cada servicio para obtener la lista de modelos o leer del directorio de modelos de la herramienta, evitando configuraciones manuales complejas.
Cambio dinámico: El sistema permitirá cambiar de motor LLM o modelo en tiempo real. Por ejemplo, un desarrollador podría empezar usando un modelo ligero para respuestas rápidas y luego conmutar a uno más potente para análisis más complejo. El servidor gestionará estas configuraciones sin requerir reinicios complicados.
Análisis de contexto extenso y capacidades locales
Acceso a recursos locales: Uno de los propósitos centrales es que el LLM local pueda analizar el contexto completo del proyecto u otros datos locales sin limitaciones estrictas de ventana de contexto. A través de MCP, el modelo puede solicitar leer archivos del repositorio, acceder a bases de datos locales, o invocar herramientas del sistema de forma controlada
en.wikipedia.org
es.wikipedia.org
. En concreto, el servidor MCP actuará como intermediario para operaciones como: lectura de archivos de código, listados de directorios del proyecto, búsqueda de texto en el repo, o incluso ejecución de comandos de build/pruebas si fuera necesario. Estas funciones se expondrán al modelo via MCP como herramientas o endpoints específicos.
Contexto sin límites artificiales: Al procesar datos localmente, el LLM no está sujeto a los límites estrictos de tamaño impuestos por servicios cloud. Esto permite, por ejemplo, resumir un repositorio grande o analizar múltiples archivos a la vez. Herramientas como Sourcegraph ya demostraron la utilidad de dar acceso completo al contexto del código mediante MCP
en.wikipedia.org
. El LLM local puede iterativamente pedir más información del proyecto hasta construir una comprensión amplia, algo difícil de lograr solo con la ventana de contexto de Copilot.
Tareas de análisis avanzadas: Se espera que el LLM local realice tareas como resúmenes de código, búsqueda de posibles bugs o vulnerabilidades en el proyecto, explicación de secciones complejas o generación de documentación a partir del código base. Estas respuestas luego pueden presentarse al desarrollador directamente o condensarse y pasarse como contexto adicional al modelo de Copilot en la nube para mejorar sus sugerencias.
Privacidad y control de datos
Procesamiento local privado: Todo el análisis de contexto lo realizará el LLM en local, garantizando que el código fuente y datos sensibles no salgan de la máquina. Esto responde a la necesidad de completa privacidad de datos que motiva usar LLMs locales
pinggy.io
. El servidor MCP debe asegurar que ninguna solicitud al LLM local provoque envío de archivos o contenidos del usuario a servicios externos no deseados.
Filtrado de información compartida: Si el flujo de trabajo combina el LLM local con GitHub Copilot (que es un servicio en la nube), se debe filtrar qué información derivada del análisis local se envía de vuelta al asistente en la nube. Idealmente solo resúmenes, conclusiones o métricas generales del proyecto (y nunca secretos, datos personales o grandes porciones de código literal) serían enviados al modelo remoto. Por ejemplo, en lugar de mandar el código completo de un archivo, el LLM local podría enviar "El archivo X define una clase Y que hace Z..." como contexto.
Permisos y seguridad: El servidor MCP debe implementar controles de permiso para las acciones del LLM sobre el sistema. MCP está diseñado con conexiones seguras y bidireccionales en mente
en.wikipedia.org
, pero existen riesgos (ej. prompt injections o combinaciones de herramientas maliciosas) si no se limitan adecuadamente las capacidades
en.wikipedia.org
. Por ello, se definirán políticas de qué directorios puede leer el LLM, qué comandos (si alguno) puede ejecutar y requerir confirmación del usuario para acciones sensibles. Manteniendo un estricto sandbox de las operaciones del modelo se protege la privacidad y la integridad del sistema.
Integración con el IDE (GitHub Copilot)
Funcionamiento conjunto: El MCP server debe integrarse de forma transparente con el IDE y con GitHub Copilot, actuando como un complemento que amplía las funciones de Copilot
docs.github.com
. Esto significa que, cuando Copilot (u otro asistente en el IDE) requiera más contexto o datos locales, pueda consultar al servidor MCP. Por ejemplo, Copilot Chat podría hacer una petición MCP para “abrir” cierto archivo o “buscar referencias” y el servidor MCP responderá con la información usando el LLM local para procesarla si hace falta.
Estándar MCP: Aprovecharemos el estándar Model Context Protocol ya adoptado por proveedores líderes (incluyendo OpenAI y GitHub)
en.wikipedia.org
. El servidor que estamos diseñando actuará como un servidor MCP local que expone las capacidades del entorno del desarrollador. Dado que MCP reutiliza conceptos del Lenguaje Server Protocol (LSP) y funciona sobre JSON-RPC
en.wikipedia.org
, es razonable implementar el servidor de forma similar a un Language Server de IDE. Muchos IDEs en 2025 soportan MCP nativamente o vía extensiones, por lo que nuestro servidor podrá registrarse como servidor MCP en, por ejemplo, VS Code o IntelliJ, permitiendo a Copilot (cliente MCP) llamarlo para obtener contexto.
Extensión/Plugin: En caso de que el IDE no soporte todavía MCP de forma automática, podría desarrollarse una pequeña extensión de IDE personalizada. Esta extensión interceptaría las solicitudes de Copilot o agregaría comandos adicionales (por ej. "Analizar proyecto con LLM local"), enviando dichas peticiones al servidor MCP vía HTTP/JSON-RPC. El resultado (p. ej. un resumen de la base de código) se mostraría en el IDE o se incorporaría a las sugerencias de Copilot. Esto brinda una experiencia integrada donde el desarrollador siente que tanto Copilot como el asistente local trabajan de la mano.
Tecnologías para una implementación sencilla
SDKs de MCP: Para minimizar el código manual, se utilizarán los SDK oficiales de MCP disponibles en varios lenguajes (Python, TypeScript/Node.js, C#, Java, etc.)
en.wikipedia.org
. Estos SDK proporcionan gran parte de la infraestructura (manejo de JSON-RPC, registro de métodos, etc.), acelerando la creación del servidor MCP. Por ejemplo, con el SDK de Python se podría definir en pocas líneas un método para “leer archivo” que el cliente (Copilot) pueda invocar, en lugar de implementar el protocolo desde cero.
APIs OpenAI-compatibles: Los motores LLM locales seleccionados ofrecen APIs compatibles con OpenAI, lo que significa que aceptan peticiones en formato similar a chat/completions y devuelven respuestas de forma estándar
pinggy.io
pinggy.io
. El servidor MCP aprovechará esto para delegar la inferencia al servicio correspondiente: en vez de desarrollar un pipeline de ML propio, simplemente reenviará la consulta del usuario (o del IDE) al endpoint local adecuado. Por ejemplo, si el usuario eligió LocalAI como backend, el servidor haría una llamada HTTP al endpoint local de LocalAI (que emula la API de OpenAI)
pinggy.io
 con el prompt dado, y retornará la respuesta del modelo. Este enfoque reduce drásticamente la necesidad de código personalizado y garantiza compatibilidad con el mayor número de modelos.
Framework web ligero: Para la interfaz web, se puede emplear un micro-framework muy utilizado como Flask (Python) o Express (Node.js) para crear rápidamente páginas de configuración y APIs REST sin mucho código. Alternativamente, herramientas orientadas a IA como Gradio podrían proporcionar una interfaz web out-of-the-box para interactuar con el LLM local, aunque en este caso se requeriría integrar la selección de modelos. Dado que la UI es principalmente para configuración, mantenerla sencilla es clave: HTML/CSS/JS estándar o un pequeño frontend React/Vue puede servir, aprovechando componentes existentes de diseño para ahorrar tiempo.
Detección de capacidades del sistema: El servidor debe obtener información básica del hardware del sistema (CPU, RAM, GPU disponible) para ayudar en la configuración. Esto se puede lograr utilizando librerías ya existentes (por ejemplo psutil en Python para consultar CPU/RAM, o la API de CUDA para VRAM) en lugar ofuscar al usuario con detalles. Con esos datos, la interfaz podría orientar al usuario sobre qué modelos son recomendables. Por ejemplo: “Tienes 8GB de RAM: se recomienda usar modelos de hasta 7B parámetros.” Esto evita que el usuario cargue un modelo inviable y nuevamente implica poco desarrollo adicional gracias a librerías disponibles.
Gestión de procesos externos: En caso de que alguno de los servicios LLM (como text-generation-webui o LocalAI) deba iniciarse por separado, el servidor puede incorporar scripts o llamadas de sistema para lanzarlos automáticamente (p. ej. ejecutar el binario de LM Studio en modo servidor API). Se usará funcionalidad nativa del lenguaje elegido (como subprocess en Python o módulos de child process en Node) para esto, con cuidado de hacerlo opcional y configurable. Lo ideal es que el MCP server detecte si el servicio está corriendo (quizá mediante ping a su puerto) y, si no, ofrezca iniciarlo. Nuevamente, apoyarse en las propias herramientas (muchas tienen modos headless o flags --api) minimiza la codificación manual.