<?php
// === НАСТРОЙКИ ===
$SECRET   = 'ваш_очень_длинный_секретный_токен_abc123xyz'; // ← Замени!
$ALLOW_IP = ['91.200.148.99']; // ← Вставь свой IP

// --- Проверка доступа ---
if (!empty($ALLOW_IP)) {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    if (!in_array($ip, $ALLOW_IP, true)) {
        http_response_code(403); exit('forbidden ip');
    }
}
if ($SECRET !== '' && ($_GET['key'] ?? '') !== $SECRET) {
    http_response_code(403); exit('forbidden');
}

// === Сканирование ===
$base = realpath(__DIR__);
$root = realpath($base . '/' . ($_GET['dir'] ?? '.'));
if (!$root || strpos($root, $base) !== 0) {
    http_response_code(400); exit('bad dir');
}

$issues = []; $files = 0;
$extAllow = ['js','html','htm','php','css','htaccess','json'];

function add_issue(&$arr, $type, $file, $line, $msg, $sev='warn'){
    $rel = str_replace($_SERVER['DOCUMENT_ROOT'], '', $file);
    $arr[] = ['type'=>$type,'file'=>$rel,'line'=>$line,'message'=>$msg,'severity'=>$sev];
}

function scan_file($path, &$issues){
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    $bn = basename($path);
    if ($bn === '.htaccess') $ext = 'htaccess';
    if (!in_array($ext, ['js','html','htm','php','css','htaccess','json'])) return;

    $txt = @file_get_contents($path);
    if ($txt === false) return;
    $lines = explode("\n", $txt);

    foreach ($lines as $i=>$ln) {
        if (strpos($ln, '...') !== false) {
            add_issue($issues,'ellipsis',$path,$i+1,'Встречено "..." — возможный обрез кода','error');
        }
    }

    if (preg_match('/api-maps\\.yandex\\.ru\\/2\\.1\\/\\?[^"\n]*/i', $txt) && !preg_match('/apikey=/i', $txt)) {
        add_issue($issues,'yandex_api',$path,0,'Загрузка Yandex API без apikey','error');
    }

    if (in_array($ext, ['html','htm'])) {
        if (preg_match('/<meta\\s+http-equiv=[\'"]Content-Security-Policy[\'"]/i', $txt)) {
            add_issue($issues,'csp_meta',$path,0,'Найдена meta-CSP — лучше убрать','warn');
        }
        if (preg_match('/\\sstyle=\\s*["\']/', $txt)) {
            add_issue($issues,'inline_style',$path,0,'Есть inline style= — мешает CSP','info');
        }
        if (preg_match('/<script[^>]*>\\s*[^<]/i', $txt)) {
            add_issue($issues,'inline_script',$path,0,'Есть inline <script> — вынести в .js','info');
        }
    }

    if ($bn === '.htaccess') {
        if (preg_match_all('/Content-Security-Policy/i', $txt) > 1) {
            add_issue($issues,'csp_dup',$path,0,'Несколько CSP — оставь одну','error');
        }
        if (preg_match('/\\\\\\s*\\n/', $txt)) {
            add_issue($issues,'csp_multiline',$path,0,'CSP многострочная с \\\\ — риск 500','error');
        }
    }

    if (preg_match_all('/https?:\\/\\/[a-z0-9.-]+/i', $txt, $m)) {
        foreach (array_unique($m[0]) as $d) {
            if (preg_match('~^https?://(trans-time\\.ru|www\\.trans-time\\.ru)~i', $d)) continue;
            add_issue($issues,'external',$path,0,'Внешний ресурс: '.$d,'info');
        }
    }
}

$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) { $files++; scan_file($f->getPathname(), $issues); }

$fmt = strtolower($_GET['fmt'] ?? 'html');
if ($fmt === 'json') {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['scanned'=>$files,'issues'=>$issues], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
    exit;
}

header('Content-Type: text/html; charset=utf-8'); ?>
<!doctype html><meta charset="utf-8"/>
<title>TT Debug Scan</title>
<style>
  body{font:14px/1.5 system-ui,Segoe UI,Roboto;margin:20px;background:#0b1020;color:#e5e7eb}
  h1{font-size:18px;margin:0 0 12px}
  .muted{opacity:.75}
  table{border-collapse:collapse;width:100%;background:#0f172a;border:1px solid #1f2a44}
  th,td{border-bottom:1px solid #1f2a44;padding:8px 10px;text-align:left;vertical-align:top}
  .error{color:#ef4444}.warn{color:#f59e0b}.info{color:#60a5fa}
  .badge{display:inline-block;padding:1px 6px;border-radius:999px;border:1px solid #1f2a44;background:#111827}
</style>
<h1>Trans-Time: скан /map <span class="muted">(файлов: <?= (int)$files ?>)</span></h1>
<?php if(!$issues){ ?>
  <p class="info">✅ Ничего подозрительного не найдено.</p>
<?php } else { ?>
  <table>
    <tr><th>Сев.</th><th>Тип</th><th>Файл</th><th>Строка</th><th>Сообщение</th></tr>
    <?php foreach($issues as $it){ ?>
      <tr>
        <td class="<?=htmlspecialchars($it['severity'])?>"><?=htmlspecialchars($it['severity'])?></td>
        <td><span class="badge"><?=htmlspecialchars($it['type'])?></span></td>
        <td><?=htmlspecialchars($it['file'])?></td>
        <td><?= (int)$it['line'] ?></td>
        <td><?=htmlspecialchars($it['message'])?></td>
      </tr>
    <?php } ?>
  </table>
<?php } ?>