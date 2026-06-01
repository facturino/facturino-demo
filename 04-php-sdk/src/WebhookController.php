<?php

declare(strict_types=1);

namespace AtelierDupont;

use Facturino\Exception\InvalidRequestException;
use Facturino\Webhook;

/**
 * Reception des webhooks Facturino.
 *
 * Verification de signature via le helper du SDK :
 *   \Facturino\Webhook::constructEvent($rawBody, $signatureHeader, $secret)
 *
 * Le helper :
 *  - extrait t=<timestamp>,v1=<hmac> de l'en-tete Facturino-Signature ;
 *  - recalcule HMAC-SHA256(secret, "<timestamp>.<rawBody>") ;
 *  - compare en temps constant (hash_equals) ;
 *  - rejette hors fenetre de tolerance (anti-rejeu, ~5 min) ;
 *  - renvoie l'enveloppe decodee { id, type, created, livemode, data:{object} }.
 *
 * Point critique : on lit le corps BRUT (php://input) AVANT tout parsing JSON,
 * car la signature porte sur les octets exacts du corps.
 */
final class WebhookController
{
    public function __construct(private readonly Config $config)
    {
    }

    /**
     * Traite la requete webhook entrante et ecrit la reponse HTTP.
     *
     * @param string                $rawBody         Corps brut (octets exacts).
     * @param array<string, string> $headers         En-tetes (cles minuscules).
     * @return array{int, array<string, mixed>}      [code HTTP, corps JSON]
     */
    public function handle(string $rawBody, array $headers): array
    {
        $secret = $this->config->webhookSecret;
        if ($secret === null) {
            return [500, [
                'error' => 'FACTURINO_WEBHOOK_SECRET non configure. '
                    . 'Recuperez le secret a la creation de l\'endpoint (etape H19).',
            ]];
        }

        $signature = $headers['facturino-signature'] ?? '';
        if ($signature === '') {
            return [400, ['error' => 'En-tete Facturino-Signature manquant.']];
        }

        try {
            // Verifie la signature ET decode l'enveloppe en une fois.
            $event = Webhook::constructEvent($rawBody, $signature, $secret);
        } catch (InvalidRequestException $e) {
            // Signature invalide / expiree : on repond 400 sans traiter.
            return [400, ['error' => $e->getMessage(), 'code' => $e->getErrorCode()]];
        }

        $this->dispatch($event);

        // 200 rapide : tout traitement long doit etre defere (file/worker).
        return [200, ['received' => true, 'type' => $event['type'] ?? null, 'id' => $event['id'] ?? null]];
    }

    /**
     * Aiguille l'evenement vers le traitement metier. Idempotent : on se base
     * sur event id + type, l'API pouvant relivrer un meme evenement.
     *
     * @param array<string, mixed> $event
     */
    private function dispatch(array $event): void
    {
        $type = $event['type'] ?? '';
        $object = $event['data']['object'] ?? ($event['data'] ?? []);

        // Dans une vraie app : persister (id, type) pour la deduplication, puis
        // mettre a jour l'etat metier. Ici on journalise simplement.
        $line = sprintf(
            "[webhook] %s id=%s objet=%s livemode=%s\n",
            $type,
            $event['id'] ?? '?',
            is_array($object) ? ($object['id'] ?? '?') : '?',
            isset($event['livemode']) ? var_export($event['livemode'], true) : '?',
        );
        error_log($line);

        match ($type) {
            'invoice.finalized' => $this->onInvoiceFinalized($object),
            'invoice.transmitted' => $this->onInvoiceTransmitted($object),
            'invoice.paid' => $this->onInvoicePaid($object),
            'quote.accepted' => $this->onQuoteAccepted($object),
            default => null, // type non gere : accuse simplement reception
        };
    }

    /** @param array<string, mixed> $invoice */
    private function onInvoiceFinalized(array $invoice): void
    {
        // Ex: declencher la generation du PDF cote SaaS, archiver le numero.
        error_log('  -> facture finalisee, numero ' . ($invoice['number'] ?? '?'));
    }

    /** @param array<string, mixed> $invoice */
    private function onInvoiceTransmitted(array $invoice): void
    {
        // Ex: la PA a transmis la facture -> marquer "emise" cote SaaS.
        error_log('  -> facture transmise a la PA, statut ' . ($invoice['status'] ?? '?'));
    }

    /** @param array<string, mixed> $invoice */
    private function onInvoicePaid(array $invoice): void
    {
        // Ex: debloquer l'acces au service pour le client (coeur SaaS).
        error_log('  -> facture encaissee, total ' . ($invoice['totals']['inclVat'] ?? '?'));
    }

    /** @param array<string, mixed> $quote */
    private function onQuoteAccepted(array $quote): void
    {
        // Ex: convertir en facture, notifier l'equipe commerciale.
        error_log('  -> devis accepte ' . ($quote['id'] ?? '?'));
    }
}
