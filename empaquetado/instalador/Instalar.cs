// Instalador de un solo archivo del Calendario de guardias.
// Lleva adentro el paquete de instalación (MSI, como recurso "msi"), lo extrae a una carpeta temporal,
// lo instala para el usuario actual (no pide permisos de administrador) y abre el programa al terminar.
// Compilado con el compilador de .NET Framework 4 que trae Windows (csc.exe): no necesita instalar nada más.
// La instalación queda LIMPIA: el paquete no incluye base de datos, médicos ni guardias.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace InstaladorCalendario
{
    internal static class Program
    {
        const string Titulo = "Calendario de guardias";

        [STAThread]
        static int Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // Si el calendario está abierto, hay que cerrarlo antes (si no, Windows no puede reemplazar sus archivos).
            if (Process.GetProcessesByName("CalendarioGuardias").Length > 0 || Process.GetProcessesByName("motor").Length > 0)
            {
                MessageBox.Show("El calendario está abierto.\n\nCerralo y volvé a abrir este instalador.",
                    Titulo, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 1;
            }

            // Si ya hay una instalación con datos, se guarda una copia de la base ANTES de actualizar (los datos nunca se tocan).
            try
            {
                string datos = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    @"Programs\CalendarioGuardias\motor\datos");
                string db = Path.Combine(datos, "guardias.db");
                if (File.Exists(db))
                {
                    string resp = Path.Combine(datos, "respaldos");
                    Directory.CreateDirectory(resp);
                    string dst = Path.Combine(resp, "guardias_" + DateTime.Now.ToString("yyyy-MM-dd") + "_antes_de_actualizar.db");
                    File.Copy(db, dst, true);
                    string wal = db + "-wal";
                    if (File.Exists(wal)) File.Copy(wal, dst + "-wal", true);
                }
            }
            catch { }

            string temp = Path.Combine(Path.GetTempPath(), "CalendarioGuardias-instalador");
            string msi = Path.Combine(temp, "Guardias-Setup.msi");
            string log = Path.Combine(temp, "instalacion.log");
            int codigo = -1;
            string detalle = null;

            using (Form f = new Form())
            {
                f.Text = Titulo;
                f.StartPosition = FormStartPosition.CenterScreen;
                f.FormBorderStyle = FormBorderStyle.FixedDialog;
                f.MaximizeBox = false; f.MinimizeBox = false; f.ControlBox = false;
                f.ClientSize = new Size(420, 130);
                f.BackColor = Color.White;
                try { f.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
                Label l = new Label();
                l.Text = "Instalando el Calendario de guardias...\n\nEsto tarda unos segundos. No cierres esta ventana.";
                l.Left = 20; l.Top = 18; l.Width = 380; l.Height = 60;
                l.Font = new Font("Segoe UI", 10f);
                ProgressBar pb = new ProgressBar();
                pb.Style = ProgressBarStyle.Marquee; pb.MarqueeAnimationSpeed = 30;
                pb.Left = 20; pb.Top = 90; pb.Width = 380; pb.Height = 18;
                f.Controls.Add(l); f.Controls.Add(pb);

                Thread t = new Thread(delegate ()
                {
                    try
                    {
                        Directory.CreateDirectory(temp);
                        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("msi"))
                        using (FileStream o = File.Create(msi))
                        {
                            byte[] buf = new byte[1 << 20]; int n;
                            while ((n = s.Read(buf, 0, buf.Length)) > 0) o.Write(buf, 0, n);
                        }
                        ProcessStartInfo psi = new ProcessStartInfo("msiexec.exe",
                            "/i \"" + msi + "\" /qn /norestart /l*v \"" + log + "\"");
                        psi.UseShellExecute = false; psi.CreateNoWindow = true;
                        using (Process p = Process.Start(psi)) { p.WaitForExit(); codigo = p.ExitCode; }
                    }
                    catch (Exception ex) { detalle = ex.Message; }
                    f.BeginInvoke((MethodInvoker)delegate { f.Close(); });
                });
                t.IsBackground = true;
                f.Shown += delegate { t.Start(); };
                Application.Run(f);
            }

            try { if (File.Exists(msi)) File.Delete(msi); } catch { }

            if (codigo == 0 || codigo == 3010)
            {
                // abrir el programa recién instalado: él muestra el aviso de "instalado" y crea el acceso del Escritorio
                string exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    @"Programs\CalendarioGuardias\app\CalendarioGuardias.exe");
                try { Process.Start(new ProcessStartInfo(exe, "--instalado") { UseShellExecute = false }); }
                catch
                {
                    MessageBox.Show("El Calendario de guardias quedó instalado.\n\nPara abrirlo, usá el acceso directo «Calendario de guardias» del Menú Inicio.",
                        Titulo, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                return 0;
            }

            MessageBox.Show("No se pudo instalar el calendario.\n\nProbá de nuevo. Si sigue igual, avisale a quien te pasó este programa.",
                Titulo, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }
    }
}
