/**
 * Butikens kolumner som appens roll får läsa: alla utom `owner_id` och `agreement_form`
 * (20261220120000_butik_agare_och_avtalsform_las.sql). De två läses genom
 * `public.store_terms`. Använd den här i stället för `select()` på stores: en läsning av
 * hela raden nekas.
 */

import { getTableColumns } from "drizzle-orm";

import { stores } from "./schema";

const { ownerId: _ownerId, agreementForm: _agreementForm, ...readable } = getTableColumns(stores);
void _ownerId;
void _agreementForm;

export const readableStoreColumns = readable;
