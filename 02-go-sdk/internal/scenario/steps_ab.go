package scenario

import (
	"context"
	"encoding/base64"
	"fmt"

	facturino "github.com/facturino/facturino-go"
)

// StepBootstrap covers phase A of the scenario: confirm the API key, find
// the seller company, warm the reference tables and read the usage.
//
//	account.Retrieve, companies.List/Get,
//	reference.ListLegalForms/ListNafCodes, usage.Retrieve.
func (r *Runner) StepBootstrap(ctx context.Context) error {
	// A.1 — Who am I: verify key, plan, environment.
	r.log.Step("account.Retrieve")
	acct, err := r.client.Account.Retrieve()
	if err != nil {
		return err
	}
	r.log.OK("plan=%s livemode=%t company=%s", acct.Plan, acct.Livemode, acct.CompanyID)
	if acct.Livemode {
		// Hard guard: the demo must never run against a live account.
		return fmt.Errorf("refusing to run: API key is in LIVE mode")
	}

	// A.2 — Seller company: prefer the account's bound company, else list.
	companyID := acct.CompanyID
	if companyID == "" {
		r.log.Step("companies.List (find seller company)")
		list, err := r.client.Companies.List(&facturino.ListParams{Limit: 1})
		if err != nil {
			return err
		}
		if len(list.Data) == 0 {
			return fmt.Errorf("no company on this account; create one in the app first")
		}
		var c facturino.Company
		if err := unmarshalFirst(list, &c); err != nil {
			return err
		}
		companyID = c.ID
	}
	r.state.CompanyID = companyID

	r.log.Step("companies.Get %s", companyID)
	company, err := r.client.Companies.Get(companyID)
	if err != nil {
		return err
	}
	r.log.OK("%s (SIRET %s, regime %s)", company.Name, company.SIRET, company.VATRegime)

	// A.2b — Company admin: general terms (CGV) round-trip + onboarding milestone.
	r.runStep("companies.UploadCGV / GetCGV / DeleteCGV + AddMilestone", func() error {
		cgv := base64.StdEncoding.EncodeToString([]byte("%PDF-1.4\n% Conditions generales de vente (demo)\n"))
		if _, err := r.client.Companies.UploadCGV(companyID, cgv); err != nil {
			return err
		}
		if _, err := r.client.Companies.GetCGV(companyID); err != nil {
			return err
		}
		if err := r.client.Companies.DeleteCGV(companyID); err != nil {
			return err
		}
		_, err := r.client.Companies.AddMilestone(companyID, "firstInvoice")
		return err
	})

	// Company settings (numbering, accounting, reminders) are configured in the
	// Facturino app console — the API consumes them but does not manage them.

	// A.3 — Reference tables used by company/customer forms.
	r.runStep("reference.ListLegalForms (search SAS)", func() error {
		forms, err := r.client.Reference.ListLegalForms(&facturino.ReferenceListParams{Search: "SAS", Limit: 5})
		if err == nil {
			r.log.OK("%d legal forms", len(forms.Data))
		}
		return err
	})
	r.runStep("reference.ListNafCodes (search conseil)", func() error {
		codes, err := r.client.Reference.ListNafCodes(&facturino.ReferenceListParams{Search: "conseil", Limit: 5})
		if err == nil {
			r.log.OK("%d NAF codes", len(codes.Data))
		}
		return err
	})

	// A.4 — Quotas: consumption vs plan limits.
	r.runStep("usage.Retrieve", func() error {
		u, err := r.client.Usage.Retrieve()
		if err == nil {
			r.log.OK("plan=%s counters=%d", u.Plan, len(u.Counters))
		}
		return err
	})

	return nil
}

// StepCatalogueAndCustomer covers phase B: build the product catalogue
// (a monthly subscription + a one-off service) and the first B2B customer,
// looking the customer up in SIRENE/VIES before creating it.
//
//	products.Create/List/Get/Update, products.ExportCsv,
//	customers.Lookup/Create/Get/Update/List, customers.ExportCsv.
func (r *Runner) StepCatalogueAndCustomer(ctx context.Context) error {
	// B.5 — Monthly subscription product (the SaaS core offer).
	r.log.Step("products.Create (monthly subscription)")
	sub, err := r.client.Products.Create(&facturino.ProductParams{
		Name:           "Abonnement Atelier Pro (mensuel)",
		Description:    "Acces complet a la plateforme, facture mensuellement.",
		Reference:      "SUB-PRO-M",
		Category:       "subscription",
		UnitPrice:      4900, // 49,00 EUR
		VATRate:        2000, // 20,00 %
		VATCode:        "S",
		Unit:           "month",
		Tags:           []string{"saas", "recurring"},
		IdempotencyKey: r.idemKey("product-sub"),
	})
	if err != nil {
		return err
	}
	r.state.SubscriptionProductID = sub.ID
	r.log.OK("subscription product %s @ %.2f EUR HT", sub.ID, float64(sub.UnitPrice)/100)

	// B.5 — One-off professional service.
	r.log.Step("products.Create (one-off setup service)")
	oneoff, err := r.client.Products.Create(&facturino.ProductParams{
		Name:           "Prestation de mise en place",
		Description:    "Atelier de configuration initiale, facture a l'unite.",
		Reference:      "SVC-SETUP",
		Category:       "service",
		UnitPrice:      75000, // 750,00 EUR
		VATRate:        2000,
		VATCode:        "S",
		Unit:           "flat_rate",
		IdempotencyKey: r.idemKey("product-oneoff"),
	})
	if err != nil {
		return err
	}
	r.state.OneOffProductID = oneoff.ID
	r.log.OK("one-off product %s", oneoff.ID)

	// B.5 — Read back, update a field, list, export.
	r.runStep("products.Get", func() error {
		_, err := r.client.Products.Get(sub.ID)
		return err
	})
	r.runStep("products.Update (refresh description)", func() error {
		_, err := r.client.Products.Update(sub.ID, &facturino.ProductUpdateParams{
			Description: "Acces complet a la plateforme + support prioritaire.",
		})
		return err
	})
	r.runStep("products.List", func() error {
		count := 0
		it := r.client.Products.List(&facturino.ProductListParams{ListParams: facturino.ListParams{Limit: 25}})
		for it.Next() {
			count++
		}
		if err := it.Err(); err != nil {
			return err
		}
		r.log.OK("%d products in catalogue", count)
		return nil
	})
	// B.5 — Filtered catalogue search: find the active subscription product
	// by name prefix and category (q + category + active).
	r.runStep("products.List (q=abonnement, category=subscription, active)", func() error {
		active := true
		it := r.client.Products.List(&facturino.ProductListParams{
			ListParams: facturino.ListParams{Limit: 25},
			Q:          "abonnement",
			Category:   "subscription",
			Active:     &active,
		})
		count := 0
		var firstMatch string
		for it.Next() {
			if firstMatch == "" {
				firstMatch = it.Product().ID
			}
			count++
		}
		if err := it.Err(); err != nil {
			return err
		}
		r.log.OK("%d matching products (first=%s)", count, firstMatch)
		return nil
	})
	r.runStep("products.ExportCsv", func() error {
		_, err := r.client.Products.ExportCSV()
		return err
	})

	// B.6 — Customer: enrich from the INSEE Sirene registry by SIRET, then
	// create a fresh B2B customer with the resolved details. Lookup returns
	// registry data (not a stored customer), so we always create below.
	const buyerSiret = "55204944776279" // example SIRET (Luhn-valid)
	r.runStep("customers.Lookup (SIRET)", func() error {
		res, err := r.client.Customers.Lookup(&facturino.CustomerLookupParams{SIRET: buyerSiret})
		if err == nil && res.Found && res.Data != nil {
			r.log.OK("SIRENE match: %s", res.Data.Name)
		}
		return err
	})

	if r.state.CustomerID == "" {
		r.log.Step("customers.Create (B2B buyer)")
		cus, err := r.client.Customers.Create(&facturino.CustomerParams{
			Name:      "Menuiserie Lemoine SARL",
			Type:      "company",
			Email:     "compta@lemoine.example",
			SIRET:     buyerSiret,
			VATNumber: "FR40552049447",
			Address: &facturino.Address{
				Line1:      "12 rue des Artisans",
				PostalCode: "69007",
				City:       "Lyon",
				Country:    "FR",
			},
			Contacts: []*facturino.Contact{{
				FirstName: "Claire",
				LastName:  "Lemoine",
				Email:     "claire@lemoine.example",
				Role:      "billing",
			}},
			PaymentTerms:   30,
			IdempotencyKey: r.idemKey("customer-buyer"),
		})
		if err != nil {
			return err
		}
		r.state.CustomerID = cus.ID
		r.log.OK("customer %s", cus.ID)
	}

	r.runStep("customers.Get", func() error {
		_, err := r.client.Customers.Get(r.state.CustomerID)
		return err
	})
	r.runStep("customers.Update (add note)", func() error {
		_, err := r.client.Customers.Update(r.state.CustomerID, &facturino.CustomerUpdateParams{
			Notes: "Client pilote de la demo Atelier Dupont.",
		})
		return err
	})
	r.runStep("customers.List", func() error {
		count := 0
		it := r.client.Customers.List(&facturino.ListParams{Limit: 25})
		for it.Next() {
			count++
		}
		if err := it.Err(); err != nil {
			return err
		}
		r.log.OK("%d customers", count)
		return nil
	})
	r.runStep("customers.ExportCsv", func() error {
		_, err := r.client.Customers.ExportCSV()
		return err
	})

	return nil
}
