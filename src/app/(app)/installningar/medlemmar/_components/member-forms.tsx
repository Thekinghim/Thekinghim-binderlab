"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Field, Input, Select } from "@/components/v2/field";

import { PreviewDialog, usePreviewFlow } from "../../awish/_components/preview-dialog";
import { applyMember, previewMember } from "../actions";

type Values = {
  name: string;
  memberNo: string;
  status: string;
  remark: string;
  tel: string;
  email: string;
};

const EMPTY: Values = { name: "", memberNo: "", status: "1", remark: "", tel: "", email: "" };

function useMemberFlow(onDone?: () => void) {
  return usePreviewFlow<Record<string, unknown>>({
    preview: (p) => previewMember(p),
    apply: (p) => applyMember(p),
    onDone,
  });
}

function MemberFields({
  values,
  set,
  withContact,
}: {
  values: Values;
  set: (v: Partial<Values>) => void;
  withContact: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="Namn">
        {(p) => (
          <Input
            {...p}
            value={values.name}
            maxLength={60}
            required
            onChange={(e) => set({ name: e.target.value })}
          />
        )}
      </Field>
      {withContact ? (
        <>
          <Field label="Telefon" hint="Frivilligt">
            {(p) => (
              <Input
                {...p}
                type="tel"
                value={values.tel}
                maxLength={20}
                onChange={(e) => set({ tel: e.target.value })}
              />
            )}
          </Field>
          <Field label="E-post" hint="Frivilligt">
            {(p) => (
              <Input
                {...p}
                type="email"
                value={values.email}
                maxLength={100}
                onChange={(e) => set({ email: e.target.value })}
              />
            )}
          </Field>
        </>
      ) : null}
      <Field label="Medlemsnummer" hint="Frivilligt">
        {(p) => (
          <Input
            {...p}
            value={values.memberNo}
            maxLength={40}
            onChange={(e) => set({ memberNo: e.target.value })}
          />
        )}
      </Field>
      <Field label="Status">
        {(p) => (
          <Select {...p} value={values.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="1">Aktiv</option>
            <option value="2">Fryst</option>
            <option value="0">Av</option>
          </Select>
        )}
      </Field>
      <Field label="Anteckning" hint="Frivilligt">
        {(p) => (
          <Input
            {...p}
            value={values.remark}
            maxLength={200}
            onChange={(e) => set({ remark: e.target.value })}
          />
        )}
      </Field>
    </div>
  );
}

function FormModal({
  open,
  title,
  values,
  set,
  withContact,
  pending,
  onClose,
  onPreview,
}: {
  open: boolean;
  title: string;
  values: Values;
  set: (v: Partial<Values>) => void;
  withContact: boolean;
  pending: boolean;
  onClose: () => void;
  onPreview: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={values.name.trim() === ""}
            onClick={onPreview}
          >
            Förhandsgranska
          </Button>
        </>
      }
    >
      <MemberFields values={values} set={set} withContact={withContact} />
    </Modal>
  );
}

/** "Ny medlem" (BatchCreateMembers med en medlem). */
export function NewMember() {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values>(EMPTY);
  const flow = useMemberFlow(() => {
    setOpen(false);
    setValues(EMPTY);
  });
  const set = (v: Partial<Values>) => setValues((old) => ({ ...old, ...v }));
  return (
    <>
      <Button variant="primary" iconLeft="plus" onClick={() => setOpen(true)}>
        Ny medlem
      </Button>
      <FormModal
        open={open && !flow.preview}
        title="Ny medlem"
        values={values}
        set={set}
        withContact
        pending={flow.pending}
        onClose={() => setOpen(false)}
        onPreview={() => flow.open({ action: "create", ...values })}
      />
      <PreviewDialog flow={flow} title="Skapa medlemmen i Awish?" confirmLabel="Skapa" />
    </>
  );
}

/** "Ändra" och "Ta bort" på en rad. Telefon och e-post ändras inte härifrån. */
export function MemberActions({
  member,
}: {
  member: { id: string; name: string; memberNo: string; status: number; remark: string | null };
}) {
  const start: Values = {
    ...EMPTY,
    name: member.name,
    memberNo: member.memberNo,
    status: String(member.status),
    remark: member.remark ?? "",
  };
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values>(start);
  const edit = useMemberFlow(() => setOpen(false));
  const remove = useMemberFlow();
  const set = (v: Partial<Values>) => setValues((old) => ({ ...old, ...v }));
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setValues(start);
          setOpen(true);
        }}
      >
        Ändra
      </Button>
      <Button
        variant="danger"
        size="sm"
        loading={remove.pending && !remove.preview}
        onClick={() => remove.open({ action: "delete", id: member.id })}
      >
        Ta bort
      </Button>
      <FormModal
        open={open && !edit.preview}
        title={`Ändra ${member.name}`}
        values={values}
        set={set}
        withContact={false}
        pending={edit.pending}
        onClose={() => setOpen(false)}
        onPreview={() =>
          edit.open({
            action: "update",
            id: member.id,
            name: values.name,
            memberNo: values.memberNo,
            status: values.status,
            remark: values.remark,
          })
        }
      />
      <PreviewDialog flow={edit} title="Spara i Awish?" confirmLabel="Spara" />
      <PreviewDialog flow={remove} title="Ta bort medlemmen?" confirmLabel="Ta bort" danger />
    </div>
  );
}
