import { Table, Column, Model, DataType, PrimaryKey } from "sequelize-typescript";

@Table({
    tableName: "system_config",
    timestamps: true,
})
export class SystemConfig extends Model {
    @PrimaryKey
    @Column(DataType.STRING)
    key!: string;

    @Column(DataType.JSON)
    value!: any;
}
