<?php

declare(strict_types=1);

namespace AtelierDupont;

use Facturino\Exception\ApiException;
use Facturino\Exception\InvalidRequestException;

/**
 * Petit journal d'execution : chaque etape du scenario y ajoute une ligne
 * (label + resultat ou erreur). Le tout est renvoye en JSON par les routes
 * HTTP, et imprime de maniere lisible en mode CLI.
 *
 * Le formatage des erreurs met toujours en avant le `request_id` — c'est la
 * reference a fournir au support Facturino.
 */
final class Console
{
    /** @var list<array<string, mixed>> */
    private array $steps = [];

    /**
     * Enregistre le resultat d'une etape reussie.
     *
     * @param string               $code     Identifiant d'etape (ex: "A1").
     * @param string               $label    Description lisible.
     * @param array<string, mixed> $summary  Champs cles a montrer (ids, statut...).
     */
    public function ok(string $code, string $label, array $summary = []): void
    {
        $this->steps[] = [
            'step' => $code,
            'label' => $label,
            'status' => 'ok',
            'summary' => $summary,
        ];
    }

    /**
     * Enregistre une etape ignoree (garde explicite, plan insuffisant...).
     */
    public function skipped(string $code, string $label, string $reason): void
    {
        $this->steps[] = [
            'step' => $code,
            'label' => $label,
            'status' => 'skipped',
            'reason' => $reason,
        ];
    }

    /**
     * Enregistre une erreur d'API en preservant le contexte de debug.
     */
    public function failed(string $code, string $label, \Throwable $e): void
    {
        $this->steps[] = [
            'step' => $code,
            'label' => $label,
            'status' => 'failed',
            'error' => self::describe($e),
        ];
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function steps(): array
    {
        return $this->steps;
    }

    /**
     * Decrit une exception du SDK sous une forme structuree et exploitable.
     * Le `request_id` est toujours expose pour les tickets de support.
     *
     * @return array<string, mixed>
     */
    public static function describe(\Throwable $e): array
    {
        if ($e instanceof InvalidRequestException) {
            return [
                'class' => $e::class,
                'message' => $e->getMessage(),
                'http_status' => $e->getHttpStatus(),
                'type' => $e->getErrorType(),
                'code' => $e->getErrorCode(),
                'param' => $e->getParam(),
                'hint' => $e->getHint(),
                'doc_url' => $e->getDocUrl(),
                'request_id' => $e->getRequestId(),
            ];
        }

        if ($e instanceof ApiException) {
            return [
                'class' => $e::class,
                'message' => $e->getMessage(),
                'http_status' => $e->getHttpStatus(),
                'request_id' => $e->getRequestId(),
            ];
        }

        return [
            'class' => $e::class,
            'message' => $e->getMessage(),
        ];
    }

    /**
     * Imprime le journal en texte lisible (mode CLI).
     */
    public function printToStdout(): void
    {
        foreach ($this->steps as $step) {
            $marker = match ($step['status']) {
                'ok' => '[ ok ]',
                'skipped' => '[skip]',
                default => '[FAIL]',
            };
            fwrite(STDOUT, sprintf("%s %-4s %s\n", $marker, $step['step'], $step['label']));

            if ($step['status'] === 'ok' && !empty($step['summary'])) {
                foreach ($step['summary'] as $key => $value) {
                    fwrite(STDOUT, sprintf("       %s = %s\n", $key, self::stringify($value)));
                }
            }
            if ($step['status'] === 'skipped') {
                fwrite(STDOUT, sprintf("       raison: %s\n", $step['reason']));
            }
            if ($step['status'] === 'failed') {
                $err = $step['error'];
                fwrite(STDOUT, sprintf("       %s\n", $err['message'] ?? 'erreur inconnue'));
                if (!empty($err['request_id'])) {
                    fwrite(STDOUT, sprintf("       request_id = %s\n", $err['request_id']));
                }
            }
        }
    }

    private static function stringify(mixed $value): string
    {
        if (is_scalar($value) || $value === null) {
            return (string) ($value ?? 'null');
        }

        return json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: '';
    }
}
