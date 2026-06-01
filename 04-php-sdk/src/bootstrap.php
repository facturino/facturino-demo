<?php

declare(strict_types=1);

/**
 * Amorcage de la demo PHP.
 *
 * - charge un fichier .env minimaliste (a la racine de facturino-demo ou dans
 *   ce dossier) dans l'environnement du process ;
 * - charge l'autoloader Composer (vendor/) qui fournit le SDK
 *   facturino/facturino-php et les classes AtelierDupont\* ;
 * - configure le SDK : cle API + URL de base.
 *
 * Si vendor/ n'existe pas encore (composer install pas lance), on enregistre
 * un autoloader PSR-4 de secours pour les classes AtelierDupont\* afin que la
 * verification syntaxique (php -l) et l'aide en ligne de commande fonctionnent
 * sans dependance reseau.
 */

namespace AtelierDupont;

use Facturino\Facturino;

require_once __DIR__ . '/Config.php';

/**
 * Charge un fichier .env (KEY=value, lignes # ignorees) dans getenv()/$_ENV.
 * Ne remplace jamais une variable deja presente dans l'environnement.
 */
function loadDotEnv(string $path): void
{
    if (!is_file($path) || !is_readable($path)) {
        return;
    }

    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) {
        return;
    }

    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) {
            continue;
        }

        $eq = strpos($line, '=');
        if ($eq === false) {
            continue;
        }

        $key = trim(substr($line, 0, $eq));
        $value = trim(substr($line, $eq + 1));

        // Retire des guillemets eventuels autour de la valeur.
        if (strlen($value) >= 2) {
            $first = $value[0];
            $last = $value[strlen($value) - 1];
            if (($first === '"' && $last === '"') || ($first === "'" && $last === "'")) {
                $value = substr($value, 1, -1);
            }
        }

        if ($key === '' || getenv($key) !== false) {
            continue;
        }

        putenv($key . '=' . $value);
        $_ENV[$key] = $value;
        $_SERVER[$key] = $value;
    }
}

// .env de la racine facturino-demo en priorite, puis un .env local optionnel.
loadDotEnv(dirname(__DIR__, 2) . '/.env');
loadDotEnv(dirname(__DIR__) . '/.env');

// Autoloader Composer si disponible, sinon repli PSR-4 pour AtelierDupont\*.
$vendorAutoload = dirname(__DIR__) . '/vendor/autoload.php';
if (is_file($vendorAutoload)) {
    require_once $vendorAutoload;
} else {
    spl_autoload_register(static function (string $class): void {
        $prefix = 'AtelierDupont\\';
        if (!str_starts_with($class, $prefix)) {
            return;
        }
        $relative = substr($class, strlen($prefix));
        $file = __DIR__ . '/' . str_replace('\\', '/', $relative) . '.php';
        if (is_file($file)) {
            require_once $file;
        }
    });
}

/**
 * Charge la configuration et initialise le SDK Facturino.
 *
 * @return Config La configuration resolue (utilisee par le routeur/CLI).
 */
function bootstrap(): Config
{
    $config = Config::fromEnv();

    // Le SDK n'est present qu'apres `composer install`. On evite une fatale
    // si la verification syntaxique tourne sans vendor/.
    if (class_exists(Facturino::class)) {
        Facturino::setApiKey($config->apiKey);
        Facturino::setApiBase($config->baseUrl);
    }

    return $config;
}
