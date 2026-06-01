<?php

declare(strict_types=1);

namespace AtelierDupont;

/**
 * Configuration lue depuis l'environnement (cf. .env.example a la racine du
 * dossier facturino-demo).
 *
 * Toute la configuration vient de l'environnement : aucune cle n'est jamais
 * ecrite en dur. On charge un fichier .env minimaliste si present, sinon on
 * se rabat sur les variables deja exportees dans le shell.
 */
final class Config
{
    public readonly string $apiKey;
    public readonly string $baseUrl;
    public readonly ?string $webhookSecret;
    public readonly string $publicBaseUrl;
    public readonly int $port;

    private function __construct(
        string $apiKey,
        string $baseUrl,
        ?string $webhookSecret,
        string $publicBaseUrl,
        int $port,
    ) {
        $this->apiKey = $apiKey;
        $this->baseUrl = $baseUrl;
        $this->webhookSecret = $webhookSecret;
        $this->publicBaseUrl = $publicBaseUrl;
        $this->port = $port;
    }

    /**
     * Construit la configuration a partir de l'environnement.
     */
    public static function fromEnv(): self
    {
        $apiKey = self::env('FACTURINO_API_KEY', '');
        if ($apiKey === '') {
            fwrite(
                STDERR,
                "FACTURINO_API_KEY est manquant. Copiez .env.example vers .env "
                . "et renseignez votre cle de test (fac_test_...).\n",
            );
        }

        // Garde-fou : ces demos ne touchent JAMAIS de donnees live.
        if (str_starts_with($apiKey, 'fac_live_')) {
            fwrite(
                STDERR,
                "Cle live detectee. Cette demo est concue pour le mode test "
                . "(fac_test_...). Abandon.\n",
            );
            exit(1);
        }

        $baseUrl = self::env('FACTURINO_BASE_URL', 'https://facturino.com/api/v1');

        return new self(
            apiKey: $apiKey,
            baseUrl: self::normalizeBaseUrl($baseUrl),
            webhookSecret: self::env('FACTURINO_WEBHOOK_SECRET', '') ?: null,
            publicBaseUrl: rtrim(self::env('PUBLIC_BASE_URL', ''), '/'),
            port: (int) self::env('PORT', '4242'),
        );
    }

    /**
     * Le SDK PHP prefixe lui-meme chaque chemin par "/v1" (cf.
     * Facturino\Resource\*::BASE_PATH = "/v1/..."). Or .env.example fournit
     * FACTURINO_BASE_URL = ".../api/v1". On retire donc un eventuel suffixe
     * "/v1" pour ne pas produire ".../api/v1/v1/invoices".
     *
     * Resultat passe a Facturino::setApiBase() : ".../api".
     */
    public static function normalizeBaseUrl(string $baseUrl): string
    {
        $trimmed = rtrim($baseUrl, '/');

        if (str_ends_with($trimmed, '/v1')) {
            $trimmed = substr($trimmed, 0, -strlen('/v1'));
        }

        return $trimmed;
    }

    /**
     * Lit une variable d'environnement (getenv + $_ENV + $_SERVER), avec
     * valeur par defaut.
     */
    private static function env(string $name, string $default): string
    {
        $value = getenv($name);
        if ($value !== false && $value !== '') {
            return $value;
        }

        foreach ([$_ENV, $_SERVER] as $bag) {
            if (isset($bag[$name]) && is_string($bag[$name]) && $bag[$name] !== '') {
                return $bag[$name];
            }
        }

        return $default;
    }
}
