<?php

declare(strict_types=1);

/**
 * Front controller — routeur HTTP minimal (zero dependance hors SDK).
 *
 * Lance avec le serveur web integre de PHP :
 *   php -S localhost:4242 -t public public/index.php
 *
 * Routes :
 *   GET  /                  Index : liste des routes disponibles.
 *   GET  /health            Sonde de disponibilite.
 *   POST /run               Run the complete A -> K workflow.
 *   POST /run/{phase}       Run one phase (a..k) — see the map below.
 *   POST /webhooks          Reception des webhooks Facturino (signature verifiee).
 *
 * Idempotency-Key : transmise via un X-Run-Id optionnel (en-tete ou query)
 * pour fixer le runId, sinon derive du jour courant (UTC).
 */

use AtelierDupont\Config;
use AtelierDupont\Scenario;
use AtelierDupont\WebhookController;

require_once __DIR__ . '/../src/bootstrap.php';

$config = \AtelierDupont\bootstrap();

// En CLI direct (`php public/index.php [phase]`), on joue le scenario sans HTTP.
if (PHP_SAPI === 'cli' && !isset($_SERVER['REQUEST_METHOD'])) {
    runCli($config, $argv);
    return;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = rtrim(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/', '/') ?: '/';

// Routage.
if ($method === 'GET' && $path === '/') {
    sendJson(200, indexPayload());
    return;
}

if ($method === 'GET' && $path === '/health') {
    sendJson(200, ['status' => 'ok', 'service' => 'atelier-dupont-php-demo']);
    return;
}

if ($method === 'POST' && $path === '/webhooks') {
    handleWebhook($config);
    return;
}

if ($method === 'POST' && $path === '/run') {
    $scenario = newScenario($config);
    $scenario->runAll();
    sendJson(200, $scenario->result());
    return;
}

if ($method === 'POST' && preg_match('#^/run/([a-kA-K])$#', $path, $m) === 1) {
    $scenario = newScenario($config);
    runPhase($scenario, strtolower($m[1]));
    sendJson(200, $scenario->result());
    return;
}

sendJson(404, ['error' => 'Route inconnue', 'path' => $path, 'method' => $method]);

// ---------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------

function handleWebhook(Config $config): void
{
    // Corps BRUT lu avant tout parsing : la signature porte sur ces octets.
    $rawBody = file_get_contents('php://input');
    if ($rawBody === false) {
        $rawBody = '';
    }

    $controller = new WebhookController($config);
    [$code, $body] = $controller->handle($rawBody, lowercaseHeaders());
    sendJson($code, $body);
}

/**
 * Construit un Scenario en lisant les options de la requete (runId).
 */
function newScenario(Config $config): Scenario
{
    $runId = requestOption('X-Run-Id', 'run_id');

    return new Scenario($config, $runId);
}

/**
 * Joue une phase isolee (avec ses prerequis quand c'est necessaire).
 */
function runPhase(Scenario $scenario, string $phase): void
{
    // Certaines phases dependent d'un companyId / customerId / invoiceId : on
    // rejoue silencieusement les prerequis minimaux avant la phase demandee.
    switch ($phase) {
        case 'a':
            $scenario->bootstrapAccount();
            break;
        case 'b':
            $scenario->bootstrapAccount();
            $scenario->catalogAndCustomer();
            break;
        case 'c':
            $scenario->bootstrapAccount();
            $scenario->catalogAndCustomer();
            $scenario->quoteToInvoice();
            break;
        case 'd':
            $scenario->bootstrapAccount();
            $scenario->catalogAndCustomer();
            $scenario->invoiceLifecycle();
            break;
        case 'e':
            $scenario->bootstrapAccount();
            $scenario->catalogAndCustomer();
            $scenario->recurring();
            break;
        case 'f':
            $scenario->bootstrapAccount();
            $scenario->catalogAndCustomer();
            $scenario->invoiceLifecycle();
            $scenario->creditNote();
            break;
        case 'g':
            $scenario->bootstrapAccount();
            $scenario->purchases();
            break;
        case 'h':
            $scenario->bootstrapAccount();
            $scenario->webhooksSetup();
            break;
        case 'i':
            $scenario->bootstrapAccount();
            $scenario->accountingAndPiloting();
            break;
        case 'j':
            $scenario->bootstrapAccount();
            $scenario->administration();
            break;
        case 'k':
            $scenario->bootstrapAccount();
            $scenario->catalogAndCustomer();
            $scenario->taxDecision();
            $scenario->depositAndSchedule();
            $scenario->decidedCreditNote();
            $scenario->decidedRecurring();
            break;
    }
}

function runCli(Config $config, array $argv): void
{
    $phase = $argv[1] ?? 'all';
    $scenario = new Scenario($config, getenv('RUN_ID') ?: null);

    if ($phase === 'all') {
        $scenario->runAll();
    } else {
        runPhase($scenario, strtolower($phase));
    }

    $scenario->log()->printToStdout();
}

// ---------------------------------------------------------------------
// Utilitaires HTTP
// ---------------------------------------------------------------------

/**
 * @return array<string, mixed>
 */
function indexPayload(): array
{
    return [
        'service' => 'Atelier Dupont — demo PHP (SDK Facturino)',
        'routes' => [
            'GET /health' => 'sonde de disponibilite',
            'POST /run' => 'complete A -> K workflow',
            'POST /run/{a..k}' => 'one workflow phase',
            'POST /webhooks' => 'reception webhooks (signature verifiee)',
        ],
        'options' => [
            'X-Run-Id | ?run_id' => 'fixe la cle d\'idempotence du run',
        ],
        'amounts' => 'centimes (10000 = 100,00 EUR) ; TVA en centiemes de % (2000 = 20,00 %)',
    ];
}

/**
 * @param array<string, mixed> $payload
 */
function sendJson(int $statusCode, array $payload): void
{
    if (PHP_SAPI !== 'cli') {
        http_response_code($statusCode);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode(
        $payload,
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE,
    );
    echo "\n";
}

/**
 * Recupere une option de requete depuis un en-tete OU un parametre de query.
 */
function requestOption(string $headerName, string $queryName): ?string
{
    $headers = lowercaseHeaders();
    $key = strtolower($headerName);
    if (isset($headers[$key]) && $headers[$key] !== '') {
        return $headers[$key];
    }

    if (isset($_GET[$queryName]) && is_string($_GET[$queryName]) && $_GET[$queryName] !== '') {
        return $_GET[$queryName];
    }

    return null;
}

/**
 * En-tetes de la requete, cles en minuscules (portable hors getallheaders()).
 *
 * @return array<string, string>
 */
function lowercaseHeaders(): array
{
    $headers = [];

    if (function_exists('getallheaders')) {
        foreach ((array) getallheaders() as $name => $value) {
            $headers[strtolower((string) $name)] = (string) $value;
        }
    }

    // Repli sur $_SERVER (HTTP_*) pour les SAPI sans getallheaders().
    foreach ($_SERVER as $name => $value) {
        if (str_starts_with((string) $name, 'HTTP_')) {
            $header = strtolower(str_replace('_', '-', substr((string) $name, 5)));
            $headers[$header] = (string) $value;
        }
    }

    return $headers;
}

function isTruthy(?string $value): bool
{
    if ($value === null) {
        return false;
    }

    return in_array(strtolower($value), ['1', 'true', 'yes', 'on'], true);
}
