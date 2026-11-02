/** Typer som Avtals klientkomponenter delar med sidan. */

/** Formulärets värden (som text, som fälten visar dem). */
export interface ContractDraft {
  id: string | null;
  storeId: string;
  title: string;
  validFrom: string;
  validTo: string;
  noticePeriodMonths: string;
  noticePeriodDays: string;
  renewalMonths: string;
  terminatedOn: string;
  terms: string;
  note: string;
  agreementIds: string[];
}

/** Ett befintligt villkor (store_agreements) att koppla till ett avtal. */
export interface AgreementOption {
  id: string;
  storeId: string;
  contractId: string | null;
  /** "Provision 12 % · hyra 750 kr/mån". */
  label: string;
  /** "1 okt. 2026 – tills vidare". */
  period: string;
}
