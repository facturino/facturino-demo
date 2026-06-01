<?php

declare(strict_types=1);

namespace AtelierDupont;

/**
 * Generateur de cles d'idempotence.
 *
 * Chaque POST de creation porte une `Idempotency-Key`. Le scenario doit etre
 * rejouable : pour une meme execution logique (meme `runId`) et une meme
 * etape, on veut une cle STABLE — un retry renvoie alors la ressource deja
 * creee plutot que d'en creer une seconde.
 *
 * Strategie : cle = hash(runId + ":" + etape). Le `runId` est derive du jour
 * (UTC) par defaut, de sorte qu'un meme parcours rejoue dans la journee est
 * idempotent, mais un nouveau jour repart sur des creations fraiches. On peut
 * forcer un runId via le constructeur (ex: en-tete X-Run-Id) pour un controle
 * fin cote appelant.
 */
final class Idempotency
{
    private string $runId;

    public function __construct(?string $runId = null)
    {
        $this->runId = $runId ?? gmdate('Y-m-d');
    }

    /**
     * Cle stable pour une etape donnee du parcours.
     */
    public function key(string $step): string
    {
        return 'idem_' . substr(hash('sha256', $this->runId . ':' . $step), 0, 32);
    }

    public function runId(): string
    {
        return $this->runId;
    }
}
