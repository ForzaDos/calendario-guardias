// Ventana propia del Calendario de guardias.
// Arranca el motor (motor.exe: servidor local en Python) como proceso hijo oculto,
// espera a que responda y muestra la página en una ventana WebView2 (sin barra de
// direcciones ni pestañas). Al cerrar la ventana guarda lo pendiente y apaga el motor.
//
// Reglas que cuida este archivo:
//  - Una sola ventana a la vez (Mutex): un segundo doble clic trae la primera al frente.
//  - La ventana solo se conecta a SU motor: lo arranca ella, con un token secreto, y comprueba que
//    el servidor del puerto lo conoce. Nunca reutiliza un servidor ajeno.
//  - No toca config.json: puerto y host van al motor por variables de entorno.
//  - Al cerrar: espera a que se guarde el último cambio (si no se puede, pregunta) y pide al
//    motor un apagado ordenado (respaldo de cierre) antes de matarlo.
//  - El motor va en un "Job Object": si la ventana se cae, Windows lo apaga (sin motores huérfanos).
//
// No usa red externa: todo es 127.0.0.1.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CalendarioGuardias
{
    internal static class Program
    {
        internal const string Titulo = "Calendario de guardias";

        private static readonly string LogPath =
            Path.Combine(AppContext.BaseDirectory, "host.log");

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindow(string clase, string titulo);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);

        /// <summary>Bitácora simple para diagnosticar problemas en la PC del usuario.</summary>
        internal static void Log(string msg)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogPath));
                File.AppendAllText(LogPath,
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + Environment.NewLine,
                    new UTF8Encoding(false));
            }
            catch { }
        }

        internal static bool RecienInstalado;

        /// <summary>Crea el acceso directo del Escritorio (lo hace el programa y no el instalador, para no tocar otras unidades).</summary>
        internal static void CrearAccesoEscritorio()
        {
            try
            {
                var t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) return;
                dynamic sh = Activator.CreateInstance(t);
                string lnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Calendario de guardias.lnk");
                dynamic l = sh.CreateShortcut(lnk);
                l.TargetPath = Application.ExecutablePath;
                l.WorkingDirectory = AppContext.BaseDirectory;
                l.IconLocation = Application.ExecutablePath + ",0";
                l.Description = "Calendario de guardias del sanatorio";
                l.Save();
                Log("acceso directo creado: " + lnk);
            }
            catch (Exception ex) { Log("no pude crear el acceso del Escritorio: " + ex.Message); }
        }

        [STAThread]
        private static void Main(string[] args)
        {
            RecienInstalado = Array.IndexOf(args, "--instalado") >= 0;   // lo manda el instalador al terminar
            // Una sola instancia por usuario de Windows.
            bool primera;
            using (var mutex = new Mutex(true, @"Local\CalendarioGuardias-Ventana", out primera))
            {
                if (!primera)
                {
                    Log("segunda instancia: traigo la primera al frente");
                    var h = FindWindow(null, Titulo);
                    if (h != IntPtr.Zero)
                    {
                        if (IsIconic(h)) ShowWindow(h, 9);   // SW_RESTORE
                        SetForegroundWindow(h);
                    }
                    return;
                }

                Log("--- inicio, exe=" + Application.ExecutablePath);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                try
                {
                    Application.Run(new Ventana());
                    Log("fin normal");
                }
                catch (Exception ex)
                {
                    Log("ERROR no controlado: " + ex);
                    MessageBox.Show(
                        "El calendario no pudo abrirse.\n\nCerralo y volvé a abrirlo. Si sigue igual, avisale a quien lo instaló.",
                        Titulo, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
        }
    }

    /// <summary>Job Object de Windows: los procesos asignados mueren cuando se cierra el último handle (o sea, si esta ventana se cae).</summary>
    internal sealed class TrabajoWindows : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimit
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters { public ulong a, b, c, d, e, f; }
        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimit
        {
            public BasicLimit Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr atributos, string nombre);
        [DllImport("kernel32.dll")]
        private static extern bool SetInformationJobObject(IntPtr job, int clase, IntPtr info, uint largo);
        [DllImport("kernel32.dll")]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proceso);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr h);

        private IntPtr _job;

        public TrabajoWindows()
        {
            try
            {
                _job = CreateJobObject(IntPtr.Zero, null);
                if (_job == IntPtr.Zero) return;
                var info = new ExtendedLimit();
                info.Basic.LimitFlags = 0x2000;   // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                int largo = Marshal.SizeOf(typeof(ExtendedLimit));
                IntPtr p = Marshal.AllocHGlobal(largo);
                try
                {
                    Marshal.StructureToPtr(info, p, false);
                    if (!SetInformationJobObject(_job, 9, p, (uint)largo))   // JobObjectExtendedLimitInformation
                    {
                        Program.Log("no pude configurar el job object");
                        CloseHandle(_job); _job = IntPtr.Zero;
                    }
                }
                finally { Marshal.FreeHGlobal(p); }
            }
            catch (Exception ex) { Program.Log("job object: " + ex.Message); _job = IntPtr.Zero; }
        }

        public void Agregar(Process proceso)
        {
            try
            {
                if (_job != IntPtr.Zero && !AssignProcessToJobObject(_job, proceso.Handle))
                    Program.Log("no pude asignar el motor al job object");
            }
            catch (Exception ex) { Program.Log("job object (agregar): " + ex.Message); }
        }

        public void Dispose()
        {
            if (_job != IntPtr.Zero) { CloseHandle(_job); _job = IntPtr.Zero; }
        }
    }

    internal sealed class Ventana : Form
    {
        private const string Titulo = Program.Titulo;

        private readonly string _appDir;
        private readonly string _datosDir;
        private readonly string _token;
        private readonly string _huella;       // lo que /api/status debe devolver en "instance"
        private readonly TrabajoWindows _trabajo = new TrabajoWindows();
        private Process _motor;
        private WebView2 _web;
        private int _puerto;
        private bool _cerrando;                // hay un cierre en curso (guardando / apagando)
        private bool _cierreOk;                // el cierre ya está decidido: dejar pasar FormClosing
        private bool _enNavegador;             // la página está abierta en el navegador, no en esta ventana

        public Ventana()
        {
            _appDir = AppContext.BaseDirectory;
            _datosDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "CalendarioGuardias");

            var bytes = new byte[24];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            _token = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
            using (var sha = SHA256.Create())
            {
                var h = sha.ComputeHash(Encoding.UTF8.GetBytes("guardias-instancia:" + _token));
                _huella = BitConverter.ToString(h).Replace("-", "").ToLowerInvariant();
            }

            Text = Titulo;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(1280, 880);
            MinimumSize = new Size(1024, 700);
            BackColor = Color.FromArgb(22, 28, 36);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            Shown += async (s, e) => await IniciarAsync();
            FormClosing += async (s, e) => await AlCerrarAsync(e);
            FormClosed += (s, e) => MatarMotor();
        }

        // ------------------------------------------------------------ motor
        private static string BuscarMotor(string appDir)
        {
            // Instalado: $INSTDIR\app\CalendarioGuardias.exe  +  $INSTDIR\motor\motor.exe
            // Prueba local: dist\app\CalendarioGuardias.exe  +  dist\motor\motor.exe
            var candidatos = new[]
            {
                Path.Combine(appDir, "motor", "motor.exe"),
                Path.Combine(appDir, "..", "motor", "motor.exe"),
                Path.Combine(appDir, "motor.exe"),
                Path.Combine(appDir, "..", "motor.exe"),
            };
            foreach (var c in candidatos)
            {
                try { if (File.Exists(Path.GetFullPath(c))) return Path.GetFullPath(c); } catch { }
            }
            return null;
        }

        private static int PuertoLibre(int desde, int hasta)
        {
            for (int p = desde; p <= hasta; p++)
            {
                try
                {
                    var l = new TcpListener(IPAddress.Loopback, p);
                    l.Start();
                    l.Stop();
                    return p;
                }
                catch (SocketException) { }
            }
            return 0;
        }

        /// <summary>Pide /api/status y devuelve el cuerpo (o null si no responde).</summary>
        private static string Status(int puerto, int timeoutMs = 1200)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + puerto + "/api/status");
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.Proxy = null;
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    if ((int)resp.StatusCode != 200) return null;
                    using (var rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                        return rd.ReadToEnd();
                }
            }
            catch { return null; }
        }

        /// <summary>Espera a que el motor PROPIO responda (comprobando su huella) o termine. Corre fuera del hilo de la interfaz.</summary>
        private bool EsperarMotor(int puerto, int intentos)
        {
            for (int i = 0; i < intentos; i++)
            {
                var p = _motor;
                if (p == null || p.HasExited) return false;
                var cuerpo = Status(puerto);
                if (cuerpo != null) return cuerpo.Contains("\"instance\": \"" + _huella + "\"") || cuerpo.Contains("\"instance\":\"" + _huella + "\"");
                Thread.Sleep(250);
            }
            return false;
        }

        /// <summary>Lee de config.json (sin modificarlo) el puerto y host preferidos. El motor busca el archivo junto a sí o en LocalAppData.</summary>
        private void LeerConfig(string carpetaMotor, out int puerto, out string host)
        {
            puerto = 8080; host = "127.0.0.1";
            foreach (var cfg in new[] { Path.Combine(carpetaMotor, "config.json"), Path.Combine(_datosDir, "config.json") })
            {
                try
                {
                    if (!File.Exists(cfg)) continue;
                    string txt = File.ReadAllText(cfg, Encoding.UTF8);
                    var m = Regex.Match(txt, "\"port\"\\s*:\\s*(\\d+)");
                    if (m.Success && int.TryParse(m.Groups[1].Value, out int p) && p > 0 && p < 65536) puerto = p;
                    var h = Regex.Match(txt, "\"host\"\\s*:\\s*\"([^\"]+)\"");
                    if (h.Success) host = h.Groups[1].Value;
                    if (host != "0.0.0.0") host = "127.0.0.1";   // la ventana solo se conecta por loopback
                    return;
                }
                catch { }
            }
        }

        private async Task IniciarAsync()
        {
            Program.Log("IniciarAsync: arranco");
            PanelEspera("Abriendo el calendario…");

            string motor = BuscarMotor(_appDir);
            Program.Log("motor encontrado: " + (motor ?? "(ninguno)"));
            if (motor == null)
            {
                MessageBox.Show(
                    "No se pudo abrir el calendario porque falta una parte del programa.\n\n" +
                    "Volvé a instalarlo, o avisale a quien te lo instaló.",
                    Titulo, MessageBoxButtons.OK, MessageBoxIcon.Information);
                SalirYa();
                return;
            }

            string carpetaMotor = Path.GetDirectoryName(motor);
            LeerConfig(carpetaMotor, out int preferido, out string host);

            // Si ya hay OTRO calendario respondiendo en el puerto preferido (p. ej. iniciar.bat), usa otra base de datos:
            // avisar para no terminar con dos calendarios con datos distintos.
            string otro = await Task.Run(() => Status(preferido));
            if (otro != null && otro.Contains("\"needs_setup\""))   // respuesta propia de este calendario (otro igual ya abierto)
            {
                MessageBox.Show(
                    "El calendario ya está abierto en esta computadora, en otra ventana.\n\n" +
                    "Para no mezclar datos, usá esa ventana, o cerrala y volvé a abrir este programa.",
                    Titulo, MessageBoxButtons.OK, MessageBoxIcon.Information);
                SalirYa(); return;
            }
            if (IsDisposed || _cierreOk) return;

            // Siempre arranca SU propio motor, en el primer puerto libre desde el configurado.
            _puerto = await Task.Run(() => PuertoLibre(preferido, Math.Min(preferido + 20, 65000)));
            if (_puerto == 0)
            {
                MessageBox.Show("No se pudo abrir el calendario en este momento.\n\nCerrá otras ventanas del calendario y probá de nuevo.",
                    Titulo, MessageBoxButtons.OK, MessageBoxIcon.Information);
                SalirYa();
                return;
            }

            var psi = new ProcessStartInfo
            {
                FileName = motor,
                WorkingDirectory = carpetaMotor,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            psi.EnvironmentVariables["GUARDIAS_PORT"] = _puerto.ToString();
            psi.EnvironmentVariables["GUARDIAS_TOKEN"] = _token;
            psi.EnvironmentVariables["GUARDIAS_SIN_NAVEGADOR"] = "1";
            try
            {
                _motor = Process.Start(psi);
                _trabajo.Agregar(_motor);
            }
            catch (Exception ex)
            {
                Program.Log("no pude iniciar el motor: " + ex);
                MessageBox.Show("No se pudo abrir el calendario.\n\nProbá de nuevo. Si sigue igual, avisale a quien te lo instaló.",
                    Titulo, MessageBoxButtons.OK, MessageBoxIcon.Information);
                SalirYa();
                return;
            }

            bool ok = await Task.Run(() => EsperarMotor(_puerto, 240));   // hasta ~1 minuto, sin congelar la ventana
            if (IsDisposed || _cierreOk) return;
            Program.Log("motor responde: " + ok + " puerto " + _puerto);
            if (!ok)
            {
                bool salio = _motor == null || _motor.HasExited;
                MessageBox.Show(
                    "El calendario tardó demasiado en abrir.\n\n" +
                    "Esperá un momento, cerralo y abrilo de nuevo. Si sigue igual, avisale a quien te lo instaló.",
                    Titulo, MessageBoxButtons.OK, MessageBoxIcon.Information);
                Program.Log("el motor no respondió (salió solo: " + salio + ")");
                SalirYa();
                return;
            }

            Program.Log("abro web en puerto " + _puerto);
            await AbrirWebAsync();
            if (Program.RecienInstalado && !IsDisposed && !_cierreOk)
            {
                Program.RecienInstalado = false;
                Program.CrearAccesoEscritorio();
                MessageBox.Show(
                    "El Calendario de guardias quedó instalado correctamente.\n\n" +
                    "Para abrirlo otra vez usá el acceso directo «Calendario de guardias» del Escritorio o del Menú Inicio.",
                    Titulo, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        private void PanelEspera(string texto)
        {
            SuspendLayout();
            Controls.Clear();
            Controls.Add(new Label
            {
                Text = texto,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = Color.FromArgb(200, 210, 225),
                Font = new Font("Segoe UI", 13f),
            });
            ResumeLayout();
        }

        /// <summary>Carpeta para el perfil de WebView2, con respaldos por si el perfil del usuario no deja escribir.</summary>
        private string CarpetaWebView()
        {
            var candidatas = new[]
            {
                Path.Combine(_datosDir, "ventana"),
                Path.Combine(Path.GetTempPath(), "CalendarioGuardias", "ventana"),
                Path.Combine(AppContext.BaseDirectory, "ventana"),
            };
            foreach (var c in candidatas)
            {
                try
                {
                    Directory.CreateDirectory(c);
                    var prueba = Path.Combine(c, ".prueba");
                    File.WriteAllText(prueba, "x");
                    File.Delete(prueba);
                    return c;
                }
                catch (Exception ex) { Program.Log("carpeta no usable: " + c + " (" + ex.GetType().Name + ")"); }
            }
            throw new IOException("No pude crear una carpeta de trabajo para la ventana.");
        }

        private async Task AbrirWebAsync()
        {
            try
            {
                string carpetaDatos = CarpetaWebView();
                Program.Log("creando entorno webview2 en " + carpetaDatos);
                var entorno = await CoreWebView2Environment.CreateAsync(null, carpetaDatos, null);
                Program.Log("entorno ok");
                _web = new WebView2 { Dock = DockStyle.Fill };
                SuspendLayout();
                Controls.Clear();
                Controls.Add(_web);
                ResumeLayout();
                await _web.EnsureCoreWebView2Async(entorno);
                Program.Log("webview listo");

                _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _web.CoreWebView2.Settings.IsZoomControlEnabled = true;
                _web.CoreWebView2.Settings.AreDevToolsEnabled = false;

                _web.Source = new Uri("http://127.0.0.1:" + _puerto + "/");
            }
            catch (Exception ex)
            {
                Program.Log("ERROR al abrir la web: " + ex);
                var r = MessageBox.Show(
                    "El calendario no se puede mostrar en esta ventana, pero sí en tu navegador (Chrome, Edge...).\n\n" +
                    "¿Querés abrirlo ahí?\n\n" +
                    "Dejá esta ventana abierta mientras lo uses. Cuando termines, cerrala.",
                    Titulo, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (r == DialogResult.Yes)
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo("http://127.0.0.1:" + _puerto + "/") { UseShellExecute = true });
                        _enNavegador = true;
                        if (_web != null) { try { _web.Dispose(); } catch { } _web = null; }
                        PanelEspera("El calendario está abierto en tu navegador.\n\nDejá esta ventana abierta mientras lo uses.\nPara terminar, cerrá esta ventana (apaga el programa).");
                        WindowState = FormWindowState.Minimized;
                        return;
                    }
                    catch (Exception ex2) { Program.Log("no pude abrir el navegador: " + ex2.Message); }
                }
                SalirYa();
            }
        }

        // ------------------------------------------------------------ cierre
        /// <summary>Cierra sin preguntar nada (para errores de arranque): apaga el motor y sale.</summary>
        private void SalirYa()
        {
            _cierreOk = true;
            MatarMotor();
            Close();
        }

        private async Task AlCerrarAsync(FormClosingEventArgs e)
        {
            if (_cierreOk) return;
            if (e.CloseReason == CloseReason.WindowsShutDown)
            {
                // Windows se está apagando: no se puede cancelar. Pedimos el apagado ordenado del motor y esperamos un momento
                // para que haga el respaldo de cierre (la página ya guardó cada cambio al tocarlo).
                try { PedirApagado(1500); _motor?.WaitForExit(3000); } catch { }
                return;
            }
            e.Cancel = true;                 // el cierre real lo hacemos nosotros cuando esté todo guardado
            if (_cerrando) return;
            _cerrando = true;
            try
            {
                if (!await PrepararCierreAsync()) { _cerrando = false; return; }
                Text = Titulo + " — cerrando…";
                await ApagarMotorAsync();
                _cierreOk = true;
                Close();
            }
            catch (Exception ex)
            {
                Program.Log("error al cerrar: " + ex);
                _cierreOk = true;
                Close();
            }
        }

        /// <summary>Espera a que la página guarde el último cambio. Devuelve false si el usuario decide no cerrar.</summary>
        private async Task<bool> PrepararCierreAsync()
        {
            if (_enNavegador)
            {
                var rn = MessageBox.Show(
                    "El calendario está abierto en tu navegador.\n\nAntes de cerrar, fijate que arriba diga «Guardado».\n\n¿Querés cerrar el calendario?",
                    Titulo, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
                return rn == DialogResult.Yes;
            }
            if (_web == null || _web.CoreWebView2 == null) return true;
            string estado = null;
            try
            {
                await _web.CoreWebView2.ExecuteScriptAsync(
                    "window.__cierre=undefined;(typeof srvPrepareClose==='function'?srvPrepareClose():Promise.resolve('ok'))" +
                    ".then(function(r){window.__cierre=String(r)},function(){window.__cierre='error'});0");
                for (int i = 0; i < 100; i++)   // hasta ~15 s
                {
                    string r = await _web.CoreWebView2.ExecuteScriptAsync("window.__cierre===undefined?'':window.__cierre");
                    r = (r ?? "").Trim('"');
                    if (r.Length > 0 && r != "null") { estado = r; break; }
                    await Task.Delay(150);
                }
            }
            catch (Exception ex) { Program.Log("preparar cierre: " + ex.Message); estado = "error"; }
            Program.Log("estado al cerrar: " + (estado ?? "(sin respuesta)"));
            if (estado == "ok") return true;

            string motivo = estado == "conflict" ? "otra persona guardó cambios al mismo tiempo"
                          : estado == "offline" ? "se cortó la conexión"
                          : estado == "login" ? "se venció tu sesión"
                          : "todavía no se confirmó el guardado";
            var r2 = MessageBox.Show(
                "Los últimos cambios todavía no se guardaron (" + motivo + ").\n\n" +
                "Si cerrás ahora, esos cambios se pierden.\n\n¿Querés cerrar igual?",
                Titulo, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            return r2 == DialogResult.Yes;
        }

        /// <summary>Pide al motor un apagado ordenado (hace el respaldo de cierre) y, si no responde, lo mata.</summary>
        private async Task ApagarMotorAsync()
        {
            try { if (_web != null) { _web.Dispose(); _web = null; } } catch { }
            var m = _motor;
            if (m == null) return;
            try
            {
                if (!m.HasExited)
                {
                    await Task.Run(() =>
                    {
                        PedirApagado(3000);
                        m.WaitForExit(8000);
                    });
                }
            }
            catch (Exception ex) { Program.Log("apagar motor: " + ex.Message); }
            MatarMotor();
        }

        /// <summary>Pide al motor el apagado ordenado (con token). No espera a que termine.</summary>
        private void PedirApagado(int timeoutMs)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + _puerto + "/api/shutdown");
                req.Method = "POST";
                req.Timeout = timeoutMs;
                req.Proxy = null;
                req.ContentLength = 0;
                req.Headers["X-Requested-With"] = "guardias";
                req.Headers["X-Shutdown-Token"] = _token;
                using (req.GetResponse()) { }
            }
            catch (Exception ex) { Program.Log("shutdown pedido: " + ex.Message); }
        }

        private void MatarMotor()
        {
            var m = _motor;
            if (m == null) return;
            try { if (!m.HasExited) m.Kill(); } catch { }
            try { m.Dispose(); } catch { }
            _motor = null;
            try { _trabajo.Dispose(); } catch { }
        }
    }
}
